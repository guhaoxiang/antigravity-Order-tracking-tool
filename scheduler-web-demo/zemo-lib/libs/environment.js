const Cluster = require("cluster");
require("dotenv").config();

/**
 * Creates an allowlist-based feature flag that checks user IDs or enterprise IDs.
 *
 * @param {Object} options
 * @param {number[]} [options.userIds] - Allowlist of user IDs
 * @param {number[]} [options.enterpriseIds] - Allowlist of enterprise IDs
 * @param {boolean} [options.matchResult=true] - Value returned when ID is in the allowlist;
 *   the opposite is returned when the ID is not in the allowlist.
 *   Use true for allowlist (whitelist) behavior, false for blocklist behavior.
 * @returns {{ checkUserId: (id: number) => boolean, checkEnterpriseId: (id: number) => boolean }}
 *
 * @example
 * // Allowlist: feature enabled only for specific users
 * const flag = createAllowlistFeatureFlag({ userIds: [1, 2, 3], matchResult: true });
 * flag.checkUserId(1);  // true  (in list)
 * flag.checkUserId(99); // false (not in list)
 *
 * @example
 * // Blocklist: feature disabled for specific enterprises
 * const flag = createAllowlistFeatureFlag({ enterpriseIds: [41, 42], matchResult: false });
 * flag.checkEnterpriseId(41); // false (in list → matchResult)
 * flag.checkEnterpriseId(1);  // true  (not in list → !matchResult)
 */
function createAllowlistFeatureFlag({
	userIds = [],
	enterpriseIds = [],
	matchResult = true,
} = {}) {
	const userIdSet = new Set(userIds);
	const enterpriseIdSet = new Set(enterpriseIds);

	return {
		checkUserId(id) {
			return userIdSet.has(id) ? matchResult : !matchResult;
		},
		checkEnterpriseId(id) {
			return enterpriseIdSet.has(id) ? matchResult : !matchResult;
		},
	};
}

const Env = {
	DEV: "development",
	PROD: "production",
	isDev: process.env.NODE_ENV !== "production",
	isProd: process.env.NODE_ENV === "production",
	isMaster: Cluster.isPrimary,
	gcpProjectId: "fluent-observer-328812",
	scheduling: process.env.NODE_ENV === "production" && Cluster.isPrimary,
	schedulingAlgo: "GRAPH_WITH_DRIVER_SHIFT",

	estimatedSpeedKmh: 15,
	estimatedAirportSpeedKmh: 30,
	estimatedLightHourAirportSpeedKmh: 45,
	estimatedDelaySeconds: 300,

	// Buffer time between reservations to avoid overlapping.
	betweenReservationBufferSeconds: 300,

	// default range for Nissan Leaf
	defaultRangeKm: 205,

	// Minimum idle time to charge the vehicle during the idle time.
	minimumIdleTimeToChargeSeconds: 40 * 60,

	// Estimated time to find a charging station.
	estimatedTimeToFindChargingStationSeconds: 20 * 60,

	// Driver load balancing feature flag
	enableDriverLoadBalancing: true,

	// Enable vehicle type aware routing
	enableVehicleTypeRouting: true,

	// Gap filling feature flag - enables hybrid proximity + gap filling algorithm
	// When enabled, unassigned reservations are gap-filled into existing schedules
	enableGapFilling: true,

	// Gap filling battery validation feature flag
	// When enabled, gap-filling validates full schedule battery feasibility before accepting a gap
	// This considers cumulative battery consumption and charging opportunities across all reservations
	// When disabled, gap-filling uses simplified battery check (assumes full battery for each gap)
	enableGapFillingBatteryValidation: true,

	// Priority-based scheduling feature flag - enables new scheduling flow:
	// 1. Partition reservations into groups (high-priority valid, high-priority invalid, low-priority)
	// 2. Run proximity on all groups first
	// 3. If fails, drop invalid/low-priority and run proximity on high-priority valid only
	// 4. Gap-fill dropped reservations in priority order
	enablePriorityBasedScheduling: true,
	// Priority-based eligibility check feature flag
	// When enabled, high-priority reservations are tested for gap-filling feasibility
	// Low-priority reservations are accepted immediately without feasibility check
	enablePriorityBasedEligibilityCheck: true,

	// Maximum range for the first reservation, to ensure that the first reservation is not too far.
	maxRangeForFirstReservationKm: 15,

	firstReservationBufferSeconds: 50 * 60,

	enableCheckIfReservationAllowed: true,

	sortLowPriorityReservationsByTime: false,

	// 行駛時間計算可調參數（可由 process.env 覆寫，供 demo 參數設定使用）
	get geoRushHourMinutes() {
		const v = process.env.GEO_RUSH_HOUR_MINUTES;
		return v !== undefined && v !== "" ? Number(v) : 10;
	},
	get geoLightHourMinutes() {
		const v = process.env.GEO_LIGHT_HOUR_MINUTES;
		return v !== undefined && v !== "" ? Number(v) : -5;
	},
	// 尖峰時段範圍（分鐘，從當天 00:00 起算）
	get geoRushHourMorningStartMin() {
		const v = process.env.GEO_RUSH_HOUR_MORNING_START;
		if (v) { const [h, m] = v.split(":").map(Number); return h * 60 + (m || 0); }
		return 6 * 60; // 06:00
	},
	get geoRushHourMorningEndMin() {
		const v = process.env.GEO_RUSH_HOUR_MORNING_END;
		if (v) { const [h, m] = v.split(":").map(Number); return h * 60 + (m || 0); }
		return 10 * 60; // 10:00
	},
	get geoRushHourEveningStartMin() {
		const v = process.env.GEO_RUSH_HOUR_EVENING_START;
		if (v) { const [h, m] = v.split(":").map(Number); return h * 60 + (m || 0); }
		return 15 * 60; // 15:00
	},
	get geoRushHourEveningEndMin() {
		const v = process.env.GEO_RUSH_HOUR_EVENING_END;
		if (v) { const [h, m] = v.split(":").map(Number); return h * 60 + (m || 0); }
		return 20 * 60; // 20:00
	},
	// 離峰時段範圍（分鐘，從當天 00:00 起算）
	get geoLightHourEarlyEndMin() {
		const v = process.env.GEO_LIGHT_HOUR_EARLY_END;
		if (v) { const [h, m] = v.split(":").map(Number); return h * 60 + (m || 0); }
		return 6 * 60 + 30; // 06:30
	},
	get geoLightHourLateStartMin() {
		const v = process.env.GEO_LIGHT_HOUR_LATE_START;
		if (v) { const [h, m] = v.split(":").map(Number); return h * 60 + (m || 0); }
		return 20 * 60; // 20:00
	},
	get geoEstimatedSpeedBands() {
		const v = process.env.GEO_ESTIMATED_SPEED_BANDS;
		if (v) {
			try {
				const arr = JSON.parse(v);
				if (Array.isArray(arr) && arr.length) {
					return arr.map((b) => ({
						maxDist: b.maxDist == null || b.maxDist === "Infinity" ? Infinity : Number(b.maxDist),
						speed: Number(b.speed),
					})).sort((a, b) => a.maxDist - b.maxDist);
				}
			} catch (_) {}
		}
		return [
			{ maxDist: 3, speed: 11.5 },
			{ maxDist: 10, speed: 13 },
			{ maxDist: 15, speed: 21.5 },
			{ maxDist: 20, speed: 25.5 },
			{ maxDist: 30, speed: 37 },
			{ maxDist: 60, speed: 47 },
			{ maxDist: 80, speed: 58 },
			{ maxDist: Infinity, speed: 62 },
		];
	},

	// SMS notification feature flags
	// Individual flags for each SMS scenario to control URL-only vs full-detail format
	smsUseUrlOnReservationConfirmation: true, // Controls format for initial reservation confirmation
	smsUseUrlOnNextDayReminder: true, // Controls format for next-day reminder (cron job)
	smsUseUrlOnDriverAssignment: true, // Controls format for driver assignment/update
	smsUseUrlOnDriverArrival: true, // Controls format for driver arrival notification

	// Master switch to enable/disable reservation confirmation SMS
	smsNotifyOnReservation: true,

	// Master switch to enable/disable driver arrival SMS (我已抵達)
	smsNotifyOnDriverArrival: false,

	// SxS Differ: Enable scenario capture logging for creating golden test scenarios
	// When enabled, logs scheduling inputs at convergence point for extraction
	enableSxsScenarioCapture: true,

	// Promo email banner feature flag - controls which enterprises see promotional messages in emails
	promoEmailBanner: createAllowlistFeatureFlag({
		enterpriseIds: [1, 49],
		matchResult: true,
	}),

	// City trip 30% off promo banner for KKday/Klook enterprises
	cityTripPromoEmailBanner: createAllowlistFeatureFlag({
		enterpriseIds: [41, 42], // ENTERPRISE_ID_KKDAY, ENTERPRISE_ID_KLOOK
		matchResult: true,
	}),

	get eligibilityCheckSchedulingConfig() {
		return {
			checkBatteryRange: true,

			// Using proximity-based scheduling algorithm
			schedulingAlgorithm: "proximity",

			// Gap filling enabled in both accommodation check and live scheduling
			enableGapFilling: this.enableGapFilling,

			// Priority-based scheduling flow
			enablePriorityBasedScheduling: this.enablePriorityBasedScheduling,

			// Enable vehicle aware routing
			enableVehicleTypeRouting: this.enableVehicleTypeRouting,
		};
	},

	get liveSchedulingConfig() {
		return {
			...this.eligibilityCheckSchedulingConfig,

			// Flags that are used to further optimize the schedule.
			enableLoadBalancing: false,
			retainLowPriorityReservations: true,
		};
	},

	get shadowSchedulingConfig() {
		return {
			...this.liveSchedulingConfig,
			// Shadow scheduling now matches production configuration
			// Vehicle-type routing disabled in both live and shadow paths
		};
	},
};

module.exports = Env;
module.exports.createAllowlistFeatureFlag = createAllowlistFeatureFlag;
