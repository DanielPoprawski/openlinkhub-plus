"use strict";
$(document).ready(function () {
	window.i18n = {
		locale: null,
		values: {},

		setTranslations: function (locale, values) {
			this.locale = locale;
			this.values = values || {};
		},

		t: function (key, fallback = "") {
			return this.values[key] ?? fallback ?? key;
		},
	};

	const cards = $("#monitoring-cards");
	const celsius =
		cards.data("celsius") !== false &&
		String(cards.data("celsius")) !== "false";
	const unit = celsius ? "°C" : "°F";
	const refreshMs = 30000;
	let rangeSeconds = 3600;
	let sensors = [];
	let resizeTimer = null;

	try {
		const stored = parseInt(localStorage.getItem("monitoringRange"));
		if (!isNaN(stored)) {
			rangeSeconds = stored;
		}
	} catch (err) {
		// localStorage unavailable; keep the default range
	}

	$.ajax({
		url: "/api/language",
		method: "GET",
		dataType: "json",
		success: function (response) {
			if (response.status === 1 && response.data) {
				i18n.setTranslations(response.data.code, response.data.values);
			}
			init();
		},
		error: function () {
			console.error("Failed to load translations");
			init();
		},
	});

	function init() {
		markActiveRange();
		loadSensors();
		setInterval(loadAllSeries, refreshMs);
	}

	function convert(value) {
		return celsius ? value : (value * 9) / 5 + 32;
	}

	function format(value) {
		return convert(value).toFixed(1) + " " + unit;
	}

	function markActiveRange() {
		$("#monitoringRange button").each(function () {
			$(this).toggleClass(
				"active",
				parseInt($(this).data("seconds")) === rangeSeconds,
			);
		});
	}

	$("#monitoringRange").on("click", "button", function () {
		rangeSeconds = parseInt($(this).data("seconds"));
		try {
			localStorage.setItem("monitoringRange", String(rangeSeconds));
		} catch (err) {
			// ignore
		}
		markActiveRange();
		loadAllSeries();
	});

	const statFields = [
		["current", "txtCurrent", "Current"],
		["min", "txtMinimum", "Minimum"],
		["max", "txtMaximum", "Maximum"],
		["average", "txtAverage", "Average"],
		["weightedAverage", "txtWeightedAverage", "Weighted average"],
		["median", "txtMedian", "Median"],
		["low1", "txtLow1", "1% low"],
		["low5", "txtLow5", "5% low"],
		["high5", "txtHigh5", "5% high"],
		["high1", "txtHigh1", "1% high"],
	];
	// Row under the graphs
	const bottomFields = [
		["current", "txtCurrent", "Current"],
		["min", "txtMinimum", "Minimum"],
		["max", "txtMaximum", "Maximum"],
		["median", "txtMedian", "Median"],
	];
	// Markers on the vertical scale, top to bottom
	const scaleMarkers = [
		["high1", "txtHigh1", "1% high", "#b91c1c"],
		["high5", "txtHigh5", "5% high", "#ef4444"],
		["high25", "txtHigh25", "25% high", "#f97316"],
		["weightedAverage", "txtWeightedAverage", "Weighted average", "#facc15"],
		["low25", "txtLow25", "25% low", "#7dd3fc"],
		["low5", "txtLow5", "5% low", "#42a5f5"],
		["low1", "txtLow1", "1% low", "#1e40af"],
	];

	function loadSensors() {
		$.ajax({
			url: "/api/telemetry/sensors",
			dataType: "JSON",
			success: function (response) {
				sensors =
					response.status === 1 && Array.isArray(response.data)
						? response.data
						: [];
				renderCards();
				loadAllSeries();
			},
		});
	}

	function renderCards() {
		cards.empty();
		if (sensors.length === 0) {
			cards.append(`
                <div class="col-12">
                    <div class="card system-card">
                        <div class="card-body">
                            <span class="settings-label">${i18n.t("txtNoMonitoringData", "No monitoring data yet")}</span>
                        </div>
                    </div>
                </div>
            `);
			return;
		}

		sensors.forEach(function (sensor) {
			const tile = function (field, extraClass) {
				return `
                    <div class="${extraClass}">
                        <div class="card p-3">
                            <div class="card-title text-ellipsis">${i18n.t(field[1], field[2])}</div>
                            <div class="monitoring-stat text-warning text-ellipsis" id="stat-${sensor.key}-${field[0]}">-</div>
                        </div>
                    </div>
                `;
			};
			const bottomTiles = bottomFields
				.map((f) => tile(f, "col-6 col-md"))
				.join("");

			cards.append(`
                <div class="col-12">
                    <div class="card system-card">
                        <div class="card-header">${escapeHtml(sensor.label)}</div>
                        <div class="card-body">
                            <div class="row g-3">
                                <div class="col-lg-9">
                                    <canvas class="telemetry-canvas" id="chart-${sensor.key}"></canvas>
                                    <div class="card-title text-ellipsis mt-3">${i18n.t("txtDistribution", "Time spent per temperature")}</div>
                                    <canvas class="telemetry-histogram" id="hist-${sensor.key}"></canvas>
                                    <div class="row g-3 mt-1">${bottomTiles}</div>
                                </div>
                                <div class="col-lg-3">
                                    <canvas class="telemetry-scale" id="scale-${sensor.key}"></canvas>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `);
		});
	}

	function loadAllSeries() {
		sensors.forEach(function (sensor) {
			loadSeries(sensor.key);
		});
	}

	function loadSeries(key) {
		$.ajax({
			url: "/api/telemetry/series/" + key + "?seconds=" + rangeSeconds,
			dataType: "JSON",
			success: function (response) {
				const canvas = document.getElementById("chart-" + key);
				if (!canvas) {
					return;
				}
				if (response.status !== 1 || !response.data) {
					drawEmpty(canvas);
					return;
				}
				const stats = response.data.stats;
				statFields.forEach(function (field) {
					const el = document.getElementById("stat-" + key + "-" + field[0]);
					if (el) {
						el.textContent = stats.count > 0 ? format(stats[field[0]]) : "-";
					}
				});
				canvas._samples = response.data.samples || [];
				drawChart(canvas, canvas._samples);

				const hist = document.getElementById("hist-" + key);
				if (hist) {
					hist._histogram = response.data.histogram || null;
					hist._stats = stats;
					drawHistogram(hist, hist._histogram, hist._stats);
				}

				const scale = document.getElementById("scale-" + key);
				if (scale) {
					scale._stats = stats;
					drawScale(scale, stats);
				}
			},
		});
	}

	// Bars are coloured by the band they fall in: beyond the 1% marks, between 1% and 5%, or the middle 90%.
	function bandColor(temp, stats) {
		if (temp < stats.low1 || temp > stats.high1) {
			return "#ef4444";
		}
		if (temp < stats.low5 || temp > stats.high5) {
			return "#facc15";
		}
		return "#42a5f5";
	}

	function drawHistogram(canvas, histogram, stats) {
		if (
			!histogram ||
			!histogram.seconds ||
			histogram.seconds.length === 0 ||
			histogram.total <= 0
		) {
			drawEmpty(canvas);
			return;
		}
		sizeCanvas(canvas);
		const ctx = canvas.getContext("2d");
		const width = canvas.width;
		const height = canvas.height;
		const marginLeft = 56;
		const marginRight = 16;
		const marginTop = 10;
		const marginBottom = 26;
		const graphWidth = width - marginLeft - marginRight;
		const graphHeight = height - marginTop - marginBottom;

		const bins = histogram.seconds.length;
		const shares = histogram.seconds.map((s) => (s / histogram.total) * 100);
		let maxShare = Math.max(...shares);
		if (maxShare <= 0) {
			maxShare = 1;
		}
		maxShare = Math.ceil(maxShare / 5) * 5;
		const barWidth = graphWidth / bins;

		ctx.clearRect(0, 0, width, height);

		// Horizontal grid with % of time labels
		ctx.strokeStyle = "#333";
		ctx.lineWidth = 1;
		ctx.fillStyle = "#aaa";
		ctx.font = "12px sans-serif";
		ctx.textAlign = "right";
		ctx.textBaseline = "middle";
		const steps = 4;
		for (let i = 0; i <= steps; i++) {
			const share = (maxShare / steps) * i;
			const y = marginTop + graphHeight - (share / maxShare) * graphHeight;
			ctx.beginPath();
			ctx.moveTo(marginLeft, y);
			ctx.lineTo(width - marginRight, y);
			ctx.stroke();
			ctx.fillText(share.toFixed(0) + "%", marginLeft - 8, y);
		}

		// Bars
		for (let i = 0; i < bins; i++) {
			const binTemp = histogram.start + i * histogram.step;
			const barHeight = (shares[i] / maxShare) * graphHeight;
			ctx.fillStyle = bandColor(binTemp + histogram.step / 2, stats);
			ctx.fillRect(
				marginLeft + i * barWidth + 1,
				marginTop + graphHeight - barHeight,
				Math.max(barWidth - 2, 1),
				barHeight,
			);
		}

		// Temperature labels along the X axis, thinned so they do not overlap
		ctx.fillStyle = "#aaa";
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		const labelEvery = Math.max(1, Math.ceil(44 / barWidth));
		for (let i = 0; i < bins; i += labelEvery) {
			const binTemp = histogram.start + i * histogram.step;
			ctx.fillText(
				convert(binTemp).toFixed(histogram.step < 1 ? 1 : 0) + unit,
				marginLeft + i * barWidth + barWidth / 2,
				marginTop + graphHeight + 6,
			);
		}

		// Axes
		ctx.strokeStyle = "#888";
		ctx.beginPath();
		ctx.moveTo(marginLeft, marginTop);
		ctx.lineTo(marginLeft, marginTop + graphHeight);
		ctx.lineTo(width - marginRight, marginTop + graphHeight);
		ctx.stroke();
	}

	function sizeCanvas(canvas) {
		const rect = canvas.getBoundingClientRect();
		canvas.width = rect.width;
		canvas.height = rect.height;
	}

	function drawEmpty(canvas) {
		sizeCanvas(canvas);
		const ctx = canvas.getContext("2d");
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = "#aaa";
		ctx.font = "14px sans-serif";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(
			i18n.t("txtNoMonitoringData", "No monitoring data yet"),
			canvas.width / 2,
			canvas.height / 2,
		);
	}

	function timeLabel(unixSeconds, spanSeconds) {
		const d = new Date(unixSeconds * 1000);
		const hh = String(d.getHours()).padStart(2, "0");
		const mm = String(d.getMinutes()).padStart(2, "0");
		if (spanSeconds >= 86400) {
			const dd = String(d.getDate()).padStart(2, "0");
			const mo = String(d.getMonth() + 1).padStart(2, "0");
			return `${dd}.${mo}. ${hh}:${mm}`;
		}
		return `${hh}:${mm}`;
	}

	function drawChart(canvas, samples) {
		if (!samples || samples.length === 0) {
			drawEmpty(canvas);
			return;
		}
		sizeCanvas(canvas);
		const ctx = canvas.getContext("2d");
		const width = canvas.width;
		const height = canvas.height;
		const marginLeft = 56;
		const marginRight = 16;
		const marginTop = 12;
		const marginBottom = 28;
		const graphWidth = width - marginLeft - marginRight;
		const graphHeight = height - marginTop - marginBottom;

		const values = samples.map((s) => convert(s[1]));
		const times = samples.map((s) => s[0]);
		let minV = Math.min(...values) - 2;
		let maxV = Math.max(...values) + 2;
		if (maxV - minV < 4) {
			maxV = minV + 4;
		}
		const minT = times[0];
		const maxT =
			times[times.length - 1] > minT ? times[times.length - 1] : minT + 1;

		const xFor = (t) => marginLeft + ((t - minT) / (maxT - minT)) * graphWidth;
		const yFor = (v) =>
			marginTop + graphHeight - ((v - minV) / (maxV - minV)) * graphHeight;

		ctx.clearRect(0, 0, width, height);

		// Horizontal grid and value labels
		ctx.strokeStyle = "#333";
		ctx.lineWidth = 1;
		ctx.fillStyle = "#aaa";
		ctx.font = "12px sans-serif";
		ctx.textAlign = "right";
		ctx.textBaseline = "middle";
		const steps = 5;
		for (let i = 0; i <= steps; i++) {
			const v = minV + ((maxV - minV) / steps) * i;
			const y = yFor(v);
			ctx.beginPath();
			ctx.moveTo(marginLeft, y);
			ctx.lineTo(width - marginRight, y);
			ctx.stroke();
			ctx.fillText(v.toFixed(0) + unit, marginLeft - 8, y);
		}

		// Time labels
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		const span = maxT - minT;
		const labels = 4;
		for (let i = 0; i <= labels; i++) {
			const t = minT + (span / labels) * i;
			const x = xFor(t);
			ctx.beginPath();
			ctx.moveTo(x, marginTop);
			ctx.lineTo(x, marginTop + graphHeight);
			ctx.stroke();
			ctx.fillText(timeLabel(t, span), x, marginTop + graphHeight + 6);
		}

		// Axes
		ctx.strokeStyle = "#888";
		ctx.beginPath();
		ctx.moveTo(marginLeft, marginTop);
		ctx.lineTo(marginLeft, marginTop + graphHeight);
		ctx.lineTo(width - marginRight, marginTop + graphHeight);
		ctx.stroke();

		// Fill
		ctx.beginPath();
		ctx.moveTo(xFor(times[0]), marginTop + graphHeight);
		samples.forEach((s, i) => ctx.lineTo(xFor(s[0]), yFor(values[i])));
		ctx.lineTo(xFor(times[times.length - 1]), marginTop + graphHeight);
		ctx.closePath();
		ctx.fillStyle = "rgba(66, 165, 245, 0.15)";
		ctx.fill();

		// Line
		ctx.strokeStyle = "#42a5f5";
		ctx.lineWidth = 2;
		ctx.beginPath();
		samples.forEach((s, i) => {
			const x = xFor(s[0]);
			const y = yFor(values[i]);
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		});
		ctx.stroke();
	}

	// Vertical thermometer scale: the gradient is anchored on the percentile markers so every
	// arrow points at a band of its own colour. Triangles sit at the true position; labels are
	// nudged apart only when markers would overlap.
	function drawScale(canvas, stats) {
		// Match the left column's height on wide screens; fixed height when stacked
		const leftColumn = canvas.closest(".row")?.querySelector(".col-lg-9");
		if (leftColumn && window.innerWidth >= 992) {
			canvas.style.height = leftColumn.offsetHeight + "px";
		} else {
			canvas.style.height = "420px";
		}
		sizeCanvas(canvas);
		const ctx = canvas.getContext("2d");
		const width = canvas.width;
		const height = canvas.height;
		ctx.clearRect(0, 0, width, height);
		if (!stats || stats.count === 0) {
			drawEmpty(canvas);
			return;
		}

		const marginTop = 16;
		const marginBottom = 16;
		const barWidth = 26;
		const barLeft = 78;
		const barRight = barLeft + barWidth;
		const barTop = marginTop;
		const barBottom = height - marginBottom;
		const barHeight = barBottom - barTop;

		let lo = convert(stats.min);
		let hi = convert(stats.max);
		if (hi - lo < 4) {
			const mid = (hi + lo) / 2;
			lo = mid - 2;
			hi = mid + 2;
		}
		const yFor = (v) => barBottom - ((convert(v) - lo) / (hi - lo)) * barHeight;

		const markers = scaleMarkers.map(function (m) {
			const y = yFor(stats[m[0]]);
			return { key: m[0], label: i18n.t(m[1], m[2]), color: m[3], y: y, labelY: y, value: stats[m[0]] };
		});
		markers.sort((a, b) => a.y - b.y);

		// Gradient with a stop at every marker, clamped to the bar ends
		const gradient = ctx.createLinearGradient(0, barTop, 0, barBottom);
		let lastStop = -1;
		gradient.addColorStop(0, markers[0].color);
		markers.forEach(function (m) {
			let stop = (m.y - barTop) / barHeight;
			stop = Math.min(1, Math.max(0, stop));
			if (stop <= lastStop) {
				stop = Math.min(1, lastStop + 0.0001);
			}
			gradient.addColorStop(stop, m.color);
			lastStop = stop;
		});
		gradient.addColorStop(1, markers[markers.length - 1].color);
		ctx.fillStyle = gradient;
		ctx.fillRect(barLeft, barTop, barWidth, barHeight);
		ctx.strokeStyle = "rgba(255,255,255,0.15)";
		ctx.lineWidth = 1;
		ctx.strokeRect(barLeft + 0.5, barTop + 0.5, barWidth - 1, barHeight - 1);

		// Range labels on the left
		ctx.fillStyle = "#aaa";
		ctx.font = "11px sans-serif";
		ctx.textAlign = "right";
		ctx.textBaseline = "middle";
		ctx.fillText(hi.toFixed(1) + unit, barLeft - 10, barTop);
		ctx.fillText(lo.toFixed(1) + unit, barLeft - 10, barBottom);

		// Current value: white triangle on the left pointing into the bar
		const yNow = yFor(stats.current);
		ctx.fillStyle = "#ffffff";
		ctx.beginPath();
		ctx.moveTo(barLeft - 2, yNow);
		ctx.lineTo(barLeft - 10, yNow - 5);
		ctx.lineTo(barLeft - 10, yNow + 5);
		ctx.closePath();
		ctx.fill();
		ctx.font = "bold 12px sans-serif";
		ctx.fillText(format(stats.current), barLeft - 14, yNow);
		ctx.font = "11px sans-serif";
		ctx.fillText(i18n.t("txtCurrent", "Current"), barLeft - 14, yNow + 13);

		// Push labels apart when markers sit close together
		const spacing = 30;
		for (let i = 1; i < markers.length; i++) {
			if (markers[i].labelY - markers[i - 1].labelY < spacing) {
				markers[i].labelY = markers[i - 1].labelY + spacing;
			}
		}
		const overflow = markers[markers.length - 1].labelY - (height - 14);
		if (overflow > 0) {
			for (let i = markers.length - 1; i >= 0; i--) {
				markers[i].labelY -= overflow;
				if (i > 0 && markers[i].labelY - markers[i - 1].labelY >= spacing) {
					break;
				}
			}
		}

		const labelX = barRight + 16;
		markers.forEach(function (m) {
			ctx.fillStyle = m.color;
			ctx.beginPath();
			ctx.moveTo(barRight + 2, m.y);
			ctx.lineTo(barRight + 10, m.y - 5);
			ctx.lineTo(barRight + 10, m.y + 5);
			ctx.closePath();
			ctx.fill();
			ctx.textAlign = "left";
			ctx.textBaseline = "middle";
			ctx.font = "bold 12px sans-serif";
			ctx.fillText(format(m.value), labelX, m.labelY - 7);
			ctx.font = "11px sans-serif";
			ctx.fillText(m.label, labelX, m.labelY + 7);
		});
	}

	$(window).on("resize", function () {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(function () {
			document.querySelectorAll(".telemetry-canvas").forEach(function (canvas) {
				drawChart(canvas, canvas._samples || []);
			});
			document
				.querySelectorAll(".telemetry-histogram")
				.forEach(function (canvas) {
					drawHistogram(canvas, canvas._histogram, canvas._stats);
				});
			document.querySelectorAll(".telemetry-scale").forEach(function (canvas) {
				drawScale(canvas, canvas._stats);
			});
		}, 150);
	});

	function escapeHtml(text) {
		return String(text)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	// Settings modal
	let currentSettings = null;

	function updateRetentionUnit() {
		const mode = $("#monitoringRetentionMode").val();
		if (mode === "size") {
			$("#monitoringRetentionUnit").text(i18n.t("txtMegabytes", "MB"));
			$("#monitoringRetentionAmount")
				.attr("max", 10240)
				.val(currentSettings ? currentSettings.retentionMB : 50);
		} else {
			$("#monitoringRetentionUnit").text(i18n.t("txtHours", "hours"));
			$("#monitoringRetentionAmount")
				.attr("max", 8760)
				.val(currentSettings ? currentSettings.retentionHours : 72);
		}
	}

	$("#monitoringRetentionMode").on("change", function () {
		if (currentSettings) {
			// Remember the value typed for the mode we are leaving
			const amount = parseInt($("#monitoringRetentionAmount").val());
			if (!isNaN(amount)) {
				if ($(this).val() === "size") {
					currentSettings.retentionHours = amount;
				} else {
					currentSettings.retentionMB = amount;
				}
			}
		}
		updateRetentionUnit();
	});

	$("#monitoringSettingsModal").on("show.bs.modal", function () {
		$.ajax({
			url: "/api/telemetry/settings",
			dataType: "JSON",
			success: function (response) {
				if (response.status !== 1 || !response.data) {
					toast.warning(response.message);
					return;
				}
				currentSettings = response.data;
				$("#monitoringEnabled").prop(
					"checked",
					currentSettings.enabled === true,
				);
				$("#monitoringInterval").val(currentSettings.interval);
				$("#monitoringRetentionMode").val(currentSettings.retentionMode);
				updateRetentionUnit();

				const list = $("#monitoringSensors");
				list.empty();
				(currentSettings.sensors || []).forEach(function (sensor) {
					list.append(`
                        <div class="settings-row">
                            <span class="settings-label text-ellipsis">${escapeHtml(sensor.label)}</span>
                            <label class="system-toggle compact">
                                <input type="checkbox" class="monitoringSensorToggle" data-key="${escapeHtml(sensor.key)}" ${sensor.enabled ? "checked" : ""}>
                                <span class="toggle-track"></span>
                            </label>
                        </div>
                    `);
				});
			},
		});
	});

	$("#btnSaveMonitoringSettings").on("click", function () {
		const mode = $("#monitoringRetentionMode").val();
		const amount = parseInt($("#monitoringRetentionAmount").val());
		const interval = parseInt($("#monitoringInterval").val());
		if (isNaN(interval) || isNaN(amount) || interval < 2 || amount < 1) {
			toast.warning(
				i18n.t("txtInvalidMonitoringSettings", "Invalid monitoring settings"),
			);
			return;
		}

		const payload = {
			enabled: $("#monitoringEnabled").is(":checked"),
			interval: interval,
			retentionMode: mode,
			retentionHours:
				mode === "time"
					? amount
					: currentSettings
						? currentSettings.retentionHours
						: 72,
			retentionMB:
				mode === "size"
					? amount
					: currentSettings
						? currentSettings.retentionMB
						: 50,
			disabled: [],
		};
		$(".monitoringSensorToggle").each(function () {
			if (!$(this).is(":checked")) {
				payload.disabled.push($(this).data("key"));
			}
		});

		$.ajax({
			url: "/api/telemetry/settings/update",
			type: "PUT",
			data: JSON.stringify(payload, null, 2),
			cache: false,
			success: function (response) {
				try {
					if (response.status === 1) {
						toast.success(response.message);
						$("#monitoringSettingsModal").modal("hide");
						if (!payload.enabled) {
							sensors = [];
							cards.empty().append(`
                                <div class="col-12">
                                    <div class="card system-card">
                                        <div class="card-body">
                                            <span class="settings-label">${i18n.t("txtMonitoringDisabled", "Monitoring is disabled. Enable it in settings.")}</span>
                                        </div>
                                    </div>
                                </div>
                            `);
						} else {
							loadSensors();
						}
					} else {
						toast.warning(response.message);
					}
				} catch (err) {
					toast.warning(response.message);
				}
			},
		});
	});
});
