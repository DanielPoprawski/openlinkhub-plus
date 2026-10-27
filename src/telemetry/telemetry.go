package telemetry

// Package: telemetry
// Periodic temperature sampling with on-disk history for the Monitoring page.
// License: GPL-3.0 or later

import (
	"OpenLinkHub/src/common"
	"OpenLinkHub/src/config"
	"OpenLinkHub/src/devices"
	"OpenLinkHub/src/logger"
	"OpenLinkHub/src/systeminfo"
	"OpenLinkHub/src/temperatures"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	RetentionByTime = "time"
	RetentionBySize = "size"

	groupCpu     = "cpu"
	groupGpu     = "gpu"
	groupLiquid  = "liquid"
	groupProbe   = "probe"
	groupStorage = "storage"

	flushInterval    = 60 * time.Second
	maxGraphPoints   = 720
	bytesPerSample   = 20 // approximate on-disk size of one "[t,v]," entry
	minInterval      = 2
	maxInterval      = 3600
	minRetentionHrs  = 1
	maxRetentionHrs  = 8760
	minRetentionMB   = 1
	maxRetentionMB   = 10240
	gapWeightFactor  = 10 // a gap longer than this many intervals is weighted as one gap of this size
	defaultInterval  = 10
	defaultRetention = 72
	defaultSizeMB    = 50
)

// Sample is one reading at unix time T.
type Sample struct {
	T int64
	V float32
}

// MarshalJSON encodes the sample as [t, v].
func (s Sample) MarshalJSON() ([]byte, error) {
	return []byte(fmt.Sprintf("[%d,%.2f]", s.T, s.V)), nil
}

// UnmarshalJSON decodes [t, v].
func (s *Sample) UnmarshalJSON(data []byte) error {
	var raw [2]float64
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	s.T = int64(raw[0])
	s.V = float32(raw[1])
	return nil
}

// Sensor identifies one logged temperature source.
type Sensor struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Group string `json:"group"`
}

// SensorState is a Sensor with its logging state, for the settings GUI.
type SensorState struct {
	Sensor
	Enabled bool `json:"enabled"`
}

// Stats summarises a window of samples. Temperatures are Celsius.
type Stats struct {
	Current         float32 `json:"current"`
	Min             float32 `json:"min"`
	Max             float32 `json:"max"`
	Average         float32 `json:"average"`
	WeightedAverage float32 `json:"weightedAverage"`
	Median          float32 `json:"median"`
	Low1            float32 `json:"low1"`
	Low5            float32 `json:"low5"`
	Low25           float32 `json:"low25"`
	High25          float32 `json:"high25"`
	High5           float32 `json:"high5"`
	High1           float32 `json:"high1"`
	Count           int     `json:"count"`
	From            int64   `json:"from"`
	To              int64   `json:"to"`
}

// Histogram is time spent per temperature bin: bin i covers [Start+i*Step, Start+(i+1)*Step).
type Histogram struct {
	Start   float32   `json:"start"`
	Step    float32   `json:"step"`
	Seconds []float32 `json:"seconds"`
	Total   float32   `json:"total"`
}

// Series is the API response for one sensor window.
type Series struct {
	Sensor    Sensor    `json:"sensor"`
	Samples   []Sample  `json:"samples"`
	Stats     Stats     `json:"stats"`
	Histogram Histogram `json:"histogram"`
}

// Settings controls the sampler. Disabled lists sensor keys that are not logged,
// so newly discovered sensors are logged by default.
type Settings struct {
	Enabled        bool     `json:"enabled"`
	Interval       int      `json:"interval"`
	RetentionMode  string   `json:"retentionMode"`
	RetentionHours int      `json:"retentionHours"`
	RetentionMB    int      `json:"retentionMB"`
	Disabled       []string `json:"disabled"`
}

// SettingsView is Settings plus every known sensor with its state.
type SettingsView struct {
	Settings
	Sensors []SensorState `json:"sensors"`
}

type seriesFile struct {
	Sensor  Sensor   `json:"sensor"`
	Samples []Sample `json:"samples"`
}

type reading struct {
	Sensor
	Value float32
}

var (
	mutex        sync.Mutex
	series       = map[string]*seriesFile{}
	settings     Settings
	location     string
	settingsFile string
	ticker       *time.Ticker
	stopChan     chan struct{}
	keyRegex     = regexp.MustCompile(`[^A-Za-z0-9_-]+`)
	groupOrder   = map[string]int{groupCpu: 0, groupGpu: 1, groupLiquid: 2, groupProbe: 3, groupStorage: 4}
)

// Init loads settings and history, then starts sampling if enabled.
func Init() {
	base := config.GetConfig().ConfigPath
	location = base + "/database/telemetry/"
	settingsFile = base + "/database/telemetry.json"

	if err := os.MkdirAll(location, 0755); err != nil {
		logger.Log(logger.Fields{"error": err, "location": location}).Error("Unable to create telemetry directory")
		return
	}

	loadSettings()
	loadSeries()

	mutex.Lock()
	prune()
	if settings.Enabled {
		start()
	}
	mutex.Unlock()
}

// Stop halts sampling and writes history to disk.
func Stop() {
	mutex.Lock()
	stop()
	mutex.Unlock()
	flush()
}

// GetSettings returns the settings plus every discoverable or stored sensor.
func GetSettings() SettingsView {
	discovered := discover()

	mutex.Lock()
	defer mutex.Unlock()

	known := map[string]Sensor{}
	for _, r := range discovered {
		known[r.Key] = r.Sensor
	}
	for key, s := range series {
		if _, ok := known[key]; !ok {
			known[key] = s.Sensor
		}
	}

	view := SettingsView{Settings: settings, Sensors: make([]SensorState, 0, len(known))}
	if view.Disabled == nil {
		view.Disabled = []string{}
	}
	for _, sensor := range known {
		view.Sensors = append(view.Sensors, SensorState{Sensor: sensor, Enabled: !isDisabled(sensor.Key)})
	}
	sortSensorStates(view.Sensors)
	return view
}

// UpdateSettings validates, persists and applies new settings without a restart.
func UpdateSettings(s Settings) bool {
	s = normalize(s)
	if err := common.SaveJsonData(settingsFile, s); err != nil {
		logger.Log(logger.Fields{"error": err, "location": settingsFile}).Error("Unable to save telemetry settings")
		return false
	}

	mutex.Lock()
	defer mutex.Unlock()

	stop()
	settings = s
	prune()
	if settings.Enabled {
		start()
	}
	return true
}

// GetSensors returns the sensors that are logged and have data, in display order.
func GetSensors() []Sensor {
	mutex.Lock()
	defer mutex.Unlock()

	list := make([]Sensor, 0, len(series))
	for key, s := range series {
		if isDisabled(key) || len(s.Samples) == 0 {
			continue
		}
		list = append(list, s.Sensor)
	}
	sort.Slice(list, func(i, j int) bool {
		if groupOrder[list[i].Group] != groupOrder[list[j].Group] {
			return groupOrder[list[i].Group] < groupOrder[list[j].Group]
		}
		return list[i].Label < list[j].Label
	})
	return list
}

// GetSeries returns the last `seconds` of a sensor with statistics, or nil if unknown.
// seconds <= 0 returns the whole stored history.
func GetSeries(key string, seconds int) *Series {
	mutex.Lock()
	defer mutex.Unlock()

	s, ok := series[key]
	if !ok {
		return nil
	}

	window := s.Samples
	if seconds > 0 {
		cutoff := time.Now().Unix() - int64(seconds)
		idx := sort.Search(len(window), func(i int) bool { return window[i].T >= cutoff })
		window = window[idx:]
	}

	return &Series{
		Sensor:    s.Sensor,
		Samples:   downsample(window, maxGraphPoints),
		Stats:     computeStats(window, settings.Interval),
		Histogram: computeHistogram(window, settings.Interval),
	}
}

// sampleWeight returns the seconds a sample "lasted": the gap to the next sample,
// capped so a sleep or outage does not dominate, and interval for the last one.
func sampleWeight(samples []Sample, i int, interval int) float64 {
	weight := float64(interval)
	if i+1 < len(samples) {
		weight = float64(samples[i+1].T - samples[i].T)
		maxGap := float64(interval * gapWeightFactor)
		if weight > maxGap {
			weight = maxGap
		}
		if weight <= 0 {
			weight = float64(interval)
		}
	}
	return weight
}

// histogramStep picks a bin width so the window's range spans at most ~40 bins,
// going as fine as 0.1 °C for sensors that barely move.
func histogramStep(span float32) float32 {
	for _, step := range []float32{0.1, 0.25, 0.5, 1, 2, 5} {
		if span/step <= 40 {
			return step
		}
	}
	return 10
}

// computeHistogram buckets time spent per temperature bin across the window's range.
func computeHistogram(samples []Sample, interval int) Histogram {
	h := Histogram{Step: 1, Seconds: []float32{}}
	if len(samples) == 0 {
		return h
	}

	minV, maxV := samples[0].V, samples[0].V
	for _, s := range samples {
		if s.V < minV {
			minV = s.V
		}
		if s.V > maxV {
			maxV = s.V
		}
	}
	h.Step = histogramStep(maxV - minV)
	h.Start = float32(math.Floor(float64(minV/h.Step))) * h.Step
	bins := int(math.Floor(float64((maxV-h.Start)/h.Step))) + 1
	h.Seconds = make([]float32, bins)

	for i, s := range samples {
		idx := int(math.Floor(float64((s.V - h.Start) / h.Step)))
		if idx < 0 {
			idx = 0
		}
		if idx >= bins {
			idx = bins - 1
		}
		w := float32(sampleWeight(samples, i, interval))
		h.Seconds[idx] += w
		h.Total += w
	}
	return h
}

// start begins the sampling loop. Caller holds mutex.
func start() {
	stopChan = make(chan struct{})
	ticker = time.NewTicker(time.Duration(settings.Interval) * time.Second)

	go func(t *time.Ticker, stop <-chan struct{}) {
		lastFlush := time.Now()
		runSample()
		for {
			select {
			case <-t.C:
				runSample()
				if time.Since(lastFlush) >= flushInterval {
					flush()
					lastFlush = time.Now()
				}
			case <-stop:
				return
			}
		}
	}(ticker, stopChan)
}

// stop ends the sampling loop. Caller holds mutex.
func stop() {
	if ticker != nil {
		ticker.Stop()
		ticker = nil
	}
	if stopChan != nil {
		close(stopChan)
		stopChan = nil
	}
}

// runSample reads every sensor and records the enabled ones.
func runSample() {
	readings := discover()
	now := time.Now().Unix()

	mutex.Lock()
	defer mutex.Unlock()

	for _, r := range readings {
		if isDisabled(r.Key) {
			continue
		}
		s, ok := series[r.Key]
		if !ok {
			s = &seriesFile{Sensor: r.Sensor}
			series[r.Key] = s
		}
		s.Sensor.Label = r.Label
		s.Samples = append(s.Samples, Sample{T: now, V: r.Value})
	}
	prune()
}

// prune applies the retention policy and drops empty series. Caller holds mutex.
func prune() {
	now := time.Now().Unix()

	if settings.RetentionMode == RetentionBySize {
		maxSamples := settings.RetentionMB * 1024 * 1024 / bytesPerSample
		total := 0
		for _, s := range series {
			total += len(s.Samples)
		}
		if total > maxSamples {
			stamps := make([]int64, 0, total)
			for _, s := range series {
				for _, sample := range s.Samples {
					stamps = append(stamps, sample.T)
				}
			}
			sort.Slice(stamps, func(i, j int) bool { return stamps[i] < stamps[j] })
			trimAll(stamps[total-maxSamples])
		}
	} else {
		trimAll(now - int64(settings.RetentionHours)*3600)
	}

	for key, s := range series {
		if len(s.Samples) == 0 {
			if err := os.Remove(location + key + ".json"); err != nil && !os.IsNotExist(err) {
				logger.Log(logger.Fields{"error": err, "key": key}).Warn("Unable to remove telemetry file")
			}
			delete(series, key)
		}
	}
}

// trimAll drops samples older than cutoff from every series. Caller holds mutex.
func trimAll(cutoff int64) {
	for _, s := range series {
		idx := sort.Search(len(s.Samples), func(i int) bool { return s.Samples[i].T >= cutoff })
		if idx > 0 {
			s.Samples = append([]Sample(nil), s.Samples[idx:]...)
		}
	}
}

// flush writes every series to disk.
func flush() {
	mutex.Lock()
	defer mutex.Unlock()

	for key, s := range series {
		// Compact encoding: the size-based retention estimate assumes ~20 bytes per sample
		data, err := json.Marshal(s)
		if err == nil {
			err = os.WriteFile(location+key+".json", data, 0644)
		}
		if err != nil {
			logger.Log(logger.Fields{"error": err, "key": key}).Error("Unable to save telemetry data")
		}
	}
}

// loadSettings reads the settings file, creating it with defaults when missing.
func loadSettings() {
	defaults := normalize(Settings{Enabled: true})
	if !common.FileExists(settingsFile) {
		settings = defaults
		if err := common.SaveJsonData(settingsFile, settings); err != nil {
			logger.Log(logger.Fields{"error": err, "location": settingsFile}).Error("Unable to save telemetry settings")
		}
		return
	}

	file, err := os.Open(settingsFile)
	if err != nil {
		logger.Log(logger.Fields{"error": err, "location": settingsFile}).Error("Unable to read telemetry settings")
		settings = defaults
		return
	}
	defer func() { _ = file.Close() }()

	var loaded Settings
	if err = json.NewDecoder(file).Decode(&loaded); err != nil {
		logger.Log(logger.Fields{"error": err, "location": settingsFile}).Error("Unable to decode telemetry settings")
		settings = defaults
		return
	}
	settings = normalize(loaded)
}

// loadSeries reads every stored sensor file.
func loadSeries() {
	files, err := os.ReadDir(location)
	if err != nil {
		logger.Log(logger.Fields{"error": err, "location": location}).Error("Unable to read telemetry directory")
		return
	}

	mutex.Lock()
	defer mutex.Unlock()

	for _, fi := range files {
		path := location + fi.Name()
		if fi.IsDir() || !common.IsValidExtension(path, ".json") {
			continue
		}
		key := strings.TrimSuffix(fi.Name(), ".json")

		file, fe := os.Open(path)
		if fe != nil {
			logger.Log(logger.Fields{"error": fe, "location": path}).Warn("Unable to read telemetry file")
			continue
		}
		var s seriesFile
		fe = json.NewDecoder(file).Decode(&s)
		_ = file.Close()
		if fe != nil {
			logger.Log(logger.Fields{"error": fe, "location": path}).Warn("Unable to decode telemetry file")
			continue
		}
		if s.Sensor.Key == "" {
			s.Sensor.Key = key
		}
		sort.Slice(s.Samples, func(i, j int) bool { return s.Samples[i].T < s.Samples[j].T })
		series[key] = &s
	}
}

// normalize clamps settings into their valid ranges and fills defaults.
func normalize(s Settings) Settings {
	if s.Interval == 0 {
		s.Interval = defaultInterval
	}
	s.Interval = clamp(s.Interval, minInterval, maxInterval)

	if s.RetentionMode != RetentionBySize {
		s.RetentionMode = RetentionByTime
	}
	if s.RetentionHours == 0 {
		s.RetentionHours = defaultRetention
	}
	s.RetentionHours = clamp(s.RetentionHours, minRetentionHrs, maxRetentionHrs)
	if s.RetentionMB == 0 {
		s.RetentionMB = defaultSizeMB
	}
	s.RetentionMB = clamp(s.RetentionMB, minRetentionMB, maxRetentionMB)

	disabled := make([]string, 0, len(s.Disabled))
	for _, key := range s.Disabled {
		key = sanitizeKey(key)
		if key != "" {
			disabled = append(disabled, key)
		}
	}
	s.Disabled = disabled
	return s
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// isDisabled reports whether a sensor key is excluded from logging. Caller holds mutex.
func isDisabled(key string) bool {
	for _, d := range settings.Disabled {
		if d == key {
			return true
		}
	}
	return false
}

// sanitizeKey keeps keys safe to use as file names.
func sanitizeKey(key string) string {
	return keyRegex.ReplaceAllString(key, "")
}

func sortSensorStates(list []SensorState) {
	sort.Slice(list, func(i, j int) bool {
		if groupOrder[list[i].Group] != groupOrder[list[j].Group] {
			return groupOrder[list[i].Group] < groupOrder[list[j].Group]
		}
		return list[i].Label < list[j].Label
	})
}

// discover reads every temperature source currently available.
func discover() []reading {
	readings := make([]reading, 0, 16)
	add := func(key, label, group string, value float32) {
		if value <= 0 {
			return
		}
		readings = append(readings, reading{Sensor: Sensor{Key: sanitizeKey(key), Label: label, Group: group}, Value: value})
	}

	add(groupCpu, "CPU", groupCpu, temperatures.GetCpuTemperature())

	if info := systeminfo.GetInfo(); info != nil {
		if len(info.GPU) == 1 {
			for idx, gpu := range info.GPU {
				add(fmt.Sprintf("gpu-%d", idx), gpu.Model, groupGpu, temperatures.GetGpuTemperature())
			}
		} else {
			for idx, gpu := range info.GPU {
				add(fmt.Sprintf("gpu-%d", idx), gpu.Model, groupGpu, temperatures.GetGpuTemperatureIndex(idx))
			}
		}
	}

	for _, st := range temperatures.GetStorageTemperatures() {
		add("storage-"+st.Key, st.Model, groupStorage, st.Temperature)
	}

	for _, dev := range devices.GetDevices() {
		if dev == nil || dev.Hidden || dev.GetDevice == nil {
			continue
		}
		for _, ch := range readChannels(dev.GetDevice) {
			group := groupProbe
			if ch.liquid {
				group = groupLiquid
			}
			add(fmt.Sprintf("dev-%s-%d", dev.Serial, ch.channelId), dev.Product+" - "+ch.name, group, ch.temperature)
		}
	}
	return readings
}

type channelReading struct {
	channelId   int
	name        string
	temperature float32
	liquid      bool
}

// readChannels extracts temperature-capable channels from a device struct via reflection.
// Every device package exposes a `Devices` map whose entries carry ChannelId, Name,
// Temperature, HasTemps and ContainsPump (plus AIO on some).
func readChannels(device interface{}) []channelReading {
	defer func() {
		if r := recover(); r != nil {
			logger.Log(logger.Fields{"error": r}).Warn("Telemetry: unable to read device channels")
		}
	}()

	v := reflect.ValueOf(device)
	if !v.IsValid() {
		return nil
	}
	v = reflect.Indirect(v)
	if v.Kind() != reflect.Struct {
		return nil
	}
	channels := v.FieldByName("Devices")
	if !channels.IsValid() || channels.Kind() != reflect.Map {
		return nil
	}

	result := make([]channelReading, 0, channels.Len())
	iter := channels.MapRange()
	for iter.Next() {
		entry := reflect.Indirect(iter.Value())
		if entry.Kind() != reflect.Struct {
			continue
		}
		if !boolField(entry, "HasTemps") {
			continue
		}
		temp := entry.FieldByName("Temperature")
		if !temp.IsValid() || (temp.Kind() != reflect.Float32 && temp.Kind() != reflect.Float64) {
			continue
		}
		value := float32(temp.Float())
		if value <= 0 {
			continue
		}

		channelId := 0
		if f := entry.FieldByName("ChannelId"); f.IsValid() && f.Kind() == reflect.Int {
			channelId = int(f.Int())
		}
		name := ""
		if f := entry.FieldByName("Name"); f.IsValid() && f.Kind() == reflect.String {
			name = f.String()
		}

		result = append(result, channelReading{
			channelId:   channelId,
			name:        name,
			temperature: value,
			liquid:      boolField(entry, "ContainsPump") || boolField(entry, "AIO"),
		})
	}
	return result
}

func boolField(v reflect.Value, name string) bool {
	f := v.FieldByName(name)
	return f.IsValid() && f.Kind() == reflect.Bool && f.Bool()
}

// downsample reduces samples to at most maxPoints by averaging fixed-size buckets.
func downsample(samples []Sample, maxPoints int) []Sample {
	if len(samples) <= maxPoints {
		return append([]Sample(nil), samples...)
	}

	bucket := (len(samples) + maxPoints - 1) / maxPoints
	out := make([]Sample, 0, maxPoints)
	for i := 0; i < len(samples); i += bucket {
		end := i + bucket
		if end > len(samples) {
			end = len(samples)
		}
		var sumT int64
		var sumV float64
		for _, s := range samples[i:end] {
			sumT += s.T
			sumV += float64(s.V)
		}
		n := int64(end - i)
		out = append(out, Sample{T: sumT / n, V: float32(sumV / float64(n))})
	}
	return out
}

// computeStats summarises a window. interval (seconds) weights the last sample
// and caps the gap used for the time-weighted average.
func computeStats(samples []Sample, interval int) Stats {
	st := Stats{Count: len(samples)}
	if len(samples) == 0 {
		return st
	}

	st.From = samples[0].T
	st.To = samples[len(samples)-1].T
	st.Current = samples[len(samples)-1].V
	st.Min = samples[0].V
	st.Max = samples[0].V

	var sum, weightedSum, weightTotal float64
	for i, s := range samples {
		if s.V < st.Min {
			st.Min = s.V
		}
		if s.V > st.Max {
			st.Max = s.V
		}
		sum += float64(s.V)

		weight := sampleWeight(samples, i, interval)
		weightedSum += float64(s.V) * weight
		weightTotal += weight
	}
	st.Average = float32(sum / float64(len(samples)))
	if weightTotal > 0 {
		st.WeightedAverage = float32(weightedSum / weightTotal)
	}

	sorted := make([]float32, len(samples))
	for i, s := range samples {
		sorted[i] = s.V
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })

	st.Median = percentile(sorted, 50)
	st.Low1 = percentile(sorted, 1)
	st.Low5 = percentile(sorted, 5)
	st.Low25 = percentile(sorted, 25)
	st.High25 = percentile(sorted, 75)
	st.High5 = percentile(sorted, 95)
	st.High1 = percentile(sorted, 99)
	return st
}

// percentile returns the nearest-rank percentile of an ascending slice.
func percentile(sorted []float32, p float64) float32 {
	if len(sorted) == 0 {
		return 0
	}
	rank := int(p/100*float64(len(sorted))+0.5) - 1
	if rank < 0 {
		rank = 0
	}
	if rank >= len(sorted) {
		rank = len(sorted) - 1
	}
	return sorted[rank]
}
