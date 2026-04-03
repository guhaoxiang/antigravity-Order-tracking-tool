const _ = require("lodash");
const moment = require("moment");
const momentTZ = require("moment-timezone");
const { createLogger } = require("./logging");
const {
	VEHICLE_TYPES,
	partitionDriversByVehicleType,
	classifyReservationsByVehicleType,
	filterStandardCompatibleReservations,
	isVehicleTypeRoutingNeeded,
	isVehicleTypeCompatible,
} = require("./vehicle-type-utils");
const { estimateReservationDuration, estimatePointToPointDuration, getDistance } = require("./geo");
const { populateInternalReservationTime } = require("./reservation");
const Env = require("./environment");
const { TAIPEI_TIMEZONE } = require("../constants/constants");
const {
	analyzeChargingOpportunity,
	createChargingTask,
	createReservationTask,
} = require("./schedule-utils");
const { tryGapFillingForReservations } = require("./gap-filling");

const logger = createLogger("vehicle-routing");

/**
 * Combine results from two scheduling passes
 * @param {Object} pass1Result - Result from large vehicle pass
 * @param {Object} pass2Result - Result from standard vehicle pass
 * @returns {Object} Combined scheduling result
 */
function combineSchedulingResults(pass1Result, pass2Result) {
	const combinedScheduleResult = {
		...pass1Result.scheduleResult,
		...pass2Result.scheduleResult,
	};

	// For unassigned reservations, use pass2Result which has already been
	// processed to include both large-vehicle-only reservations and 
	// any standard-compatible reservations that couldn't be assigned
	const combinedUnassigned = pass2Result.unassignedReservations || [];

	// The overall compatibility is true only if both passes are compatible
	const areCompatible = pass1Result.areCompatible && pass2Result.areCompatible;

	return {
		areCompatible,
		scheduleResult: combinedScheduleResult,
		unassignedReservations: combinedUnassigned,
	};
}

/**
 * Two-pass packing vehicle routing scheduler
 * Step 1: Check if large vehicle drivers can handle all large-required reservations
 * Step 2: Build schedule for large drivers with large-required reservations
 * Step 3: Sort remaining regular reservations by time
 * Step 4: Pack regular reservations into gaps in large vehicle schedules
 * Step 5: Schedule remaining reservations with regular drivers
 *
 * @param {Array} reservations - Array of reservation objects
 * @param {Array} driverHours - Array of driver shift objects
 * @param {Function} schedulingAlgorithm - The underlying scheduling algorithm function
 * @param {Object} options - Scheduling options to pass to the algorithm
 * @returns {Object} Combined scheduling result
 */
function vehicleRoutingScheduler(reservations, driverHours, schedulingAlgorithm, options = {}) {
	// Handle null/undefined driverHours gracefully
	if (!driverHours || !Array.isArray(driverHours)) {
		logger.warn(
			{
				driverHours,
				reservationsCount: reservations?.length || 0,
			},
			"[vehicleRoutingScheduler] driverHours is null or not an array, delegating to standard algorithm"
		);
		return schedulingAlgorithm(reservations, driverHours, options);
	}

	logger.info(
		{
			totalReservations: reservations.length,
			totalDrivers: driverHours.length,
			schedulingAlgorithm: options.schedulingAlgorithm || "unknown",
		},
		"[vehicleRoutingScheduler] Starting two-pass packing vehicle routing"
	);

	// Check if vehicle type routing is actually needed
	const routingNeeded = isVehicleTypeRoutingNeeded(driverHours, reservations);
	if (!routingNeeded) {
		logger.info(
			{},
			"[vehicleRoutingScheduler] No vehicle type routing needed - delegating to standard algorithm"
		);
		// If no vehicle type considerations are needed, just run the standard algorithm
		return schedulingAlgorithm(reservations, driverHours, options);
	}

	// Partition drivers by vehicle type
	const { largeVehicleDrivers, standardVehicleDrivers } = partitionDriversByVehicleType(driverHours);

	// Classify reservations by requirements
	const { largeRequiredReservations, anyTypeReservations } = classifyReservationsByVehicleType(reservations);

	logger.info(
		{
			largeVehicleDrivers: largeVehicleDrivers.length,
			standardVehicleDrivers: standardVehicleDrivers.length,
			largeRequiredReservations: largeRequiredReservations.length,
			anyTypeReservations: anyTypeReservations.length,
		},
		"[vehicleRoutingScheduler] Driver and reservation classification complete"
	);

	// STEP 1: Pre-check large vehicle capacity
	if (largeRequiredReservations.length > 0 && largeVehicleDrivers.length === 0) {
		logger.warn(
			{
				largeRequiredReservations: largeRequiredReservations.length,
				largeVehicleDrivers: 0,
			},
			"[vehicleRoutingScheduler] WARNING: Large-required reservations but no large vehicle drivers available"
		);
	}

	// STEP 2: Build initial large vehicle schedules with large-required reservations
	let largeVehicleSchedules = {};
	let unassignedLargeRequired = [];

	if (largeRequiredReservations.length > 0 && largeVehicleDrivers.length === 0) {
		// No large drivers available but have large-required reservations - mark them as unassigned
		unassignedLargeRequired = [...largeRequiredReservations];
		logger.info(
			{
				unassignedLargeRequired: unassignedLargeRequired.length,
			},
			"[vehicleRoutingScheduler] STEP 2 skipped - no large drivers, marking large-required reservations as unassigned"
		);
	} else if (largeVehicleDrivers.length > 0 && largeRequiredReservations.length > 0) {
		logger.info(
			{
				driversInPass1: largeVehicleDrivers.length,
				largeRequiredReservations: largeRequiredReservations.length,
			},
			"[vehicleRoutingScheduler] STEP 2: Building schedules for large vehicle drivers with large-required reservations"
		);

		const pass1Result = schedulingAlgorithm(largeRequiredReservations, largeVehicleDrivers, {
			...options,
			scenario: `${options.scenario || "vehicle-routing"} - pass 1 (large vehicle schedules)`,
		});

		largeVehicleSchedules = pass1Result.scheduleResult;
		unassignedLargeRequired = pass1Result.unassignedReservations || [];

		logger.info(
			{
				assignedLargeDrivers: Object.keys(largeVehicleSchedules).length,
				unassignedLargeRequired: unassignedLargeRequired.length,
			},
			"[vehicleRoutingScheduler] STEP 2 complete"
		);
	}

	// STEP 3: Sort remaining regular reservations by time
	const regularReservations = [...anyTypeReservations].sort(
		(a, b) => a.reservationTime - b.reservationTime
	);

	logger.info(
		{
			regularReservations: regularReservations.length,
		},
		"[vehicleRoutingScheduler] STEP 3: Sorted regular reservations by time"
	);

	// STEP 4: Pack regular reservations into gaps in large vehicle schedules using proven gap-filling logic
	let packedReservations = [];
	let remainingRegularReservations = [...regularReservations];

		if (largeVehicleDrivers.length > 0 && Object.keys(largeVehicleSchedules).length > 0) {
		logger.info(
			{
				largeVehicleDriversWithSchedules: Object.keys(largeVehicleSchedules).length,
				candidateReservations: remainingRegularReservations.length,
			},
			"[vehicleRoutingScheduler] STEP 4: Packing regular reservations into large vehicle schedule gaps (using gap-filling)"
		);

		// Get work day start from options or calculate from first reservation
		// CRITICAL: Must use Taiwan timezone - startOf("day") without .tz() uses system timezone (UTC on production),
		// which shifts workDayStart by +8 hours, causing incorrect shift end times in gap-filling
		const workDayStart = options.workDayStart ||
			momentTZ.unix(reservations[0]?.reservationTime || momentTZ().unix()).tz(TAIPEI_TIMEZONE).startOf("day").unix();

		// Use proven gap-filling logic to pack reservations into large vehicle schedules
		const gapFillingResult = tryGapFillingForReservations(
			remainingRegularReservations,
			largeVehicleSchedules,
			largeVehicleDrivers,
			workDayStart,
			options
		);

		// Update schedules and tracking variables with gap-filling results
		largeVehicleSchedules = gapFillingResult.updatedSchedule;
		packedReservations = gapFillingResult.assignedReservations;
		remainingRegularReservations = gapFillingResult.failedReservations;

		logger.info(
			{
				packedReservations: packedReservations.length,
				remainingRegularReservations: remainingRegularReservations.length,
			},
			"[vehicleRoutingScheduler] STEP 4 complete"
		);
	}

	// STEP 5: Schedule remaining reservations with ALL available drivers
	// Large vehicle drivers can handle regular reservations (they're compatible with any requirement except LARGE-only)
	// 在這一步驟中，七人座駕駛無論是否已在 STEP 2 分配過大型行程，都應視為可用來承接一般（非 LARGE-only）行程。
	// 這樣可以確保「七人座駕駛可以同時跑七人座與五人座行程」，由底層演算法依據 proximity 與時間／續航條件做最終選擇。
	let regularDriverSchedules = {};
	let finalUnassigned = [];

	// STEP 5 只使用五人座司機。
	// 七人座司機已在 STEP 2（七人座訂單）+ STEP 4（gap-fill 一般訂單）處理完畢，
	// 若在此處再次加入七人座司機，proximity 會把他們當成「空的」重新排程，
	// 導致合併時 STEP 2+4 的排程被覆蓋（spread overwrite bug）。
	const allAvailableDrivers = [...standardVehicleDrivers];

	if (allAvailableDrivers.length > 0 && remainingRegularReservations.length > 0) {
		logger.info(
			{
				driversInPass2: allAvailableDrivers.length,
				availableLargeDrivers: largeVehicleDrivers.length,
				standardDrivers: standardVehicleDrivers.length,
				reservationsForPass2: remainingRegularReservations.length,
			},
			"[vehicleRoutingScheduler] STEP 5: Scheduling remaining reservations with all available drivers (including unused large vehicle drivers)"
		);

		const pass2Result = schedulingAlgorithm(remainingRegularReservations, allAvailableDrivers, {
			...options,
			scenario: `${options.scenario || "vehicle-routing"} - pass 2 (all available drivers)`,
		});

		regularDriverSchedules = pass2Result.scheduleResult;
		finalUnassigned = [
			...unassignedLargeRequired,
			...(pass2Result.unassignedReservations || []),
		];

		logger.info(
			{
				assignedDrivers: Object.keys(regularDriverSchedules).length,
				unassignedAfterPass2: pass2Result.unassignedReservations?.length || 0,
			},
			"[vehicleRoutingScheduler] STEP 5 complete"
		);
	} else {
		finalUnassigned = [...unassignedLargeRequired, ...remainingRegularReservations];
		logger.info(
			{},
			`[vehicleRoutingScheduler] STEP 5 skipped - ${allAvailableDrivers.length === 0 ? "no available drivers" : "no remaining reservations"}`
		);
	}

	// 合併排程：先放入 STEP 2+4 結果，再合併 STEP 5（安全合併，不覆蓋）
	const combinedSchedules = {};
	for (const [id, data] of Object.entries(largeVehicleSchedules)) {
		combinedSchedules[id] = data;
	}
	for (const [id, data] of Object.entries(regularDriverSchedules)) {
		if (combinedSchedules[id]) {
			// 同一位司機在兩個 pass 都有排程 → 合併 reservations 和 tasks
			combinedSchedules[id] = {
				reservations: [...combinedSchedules[id].reservations, ...data.reservations]
					.sort((a, b) => a.reservationTime - b.reservationTime),
				tasks: [...combinedSchedules[id].tasks, ...data.tasks]
					.sort((a, b) => a.startTime - b.startTime),
			};
		} else {
			combinedSchedules[id] = data;
		}
	}

	const finalResult = {
		areCompatible: finalUnassigned.length === 0,
		scheduleResult: combinedSchedules,
		unassignedReservations: finalUnassigned,
	};

	logger.info(
		{
			totalAssignedDrivers: Object.keys(combinedSchedules).length,
			largeVehicleDriversUsed: Object.keys(largeVehicleSchedules).length,
			regularDriversUsed: Object.keys(regularDriverSchedules).length,
			totalPackedReservations: packedReservations.length,
			totalUnassignedReservations: finalUnassigned.length,
			finalAreCompatible: finalResult.areCompatible,
		},
		"[vehicleRoutingScheduler] Two-pass packing vehicle routing complete"
	);

	return finalResult;
}

/**
 * Factory function to create a vehicle-routing-aware version of a scheduling algorithm
 * @param {Function} baseSchedulingAlgorithm - The base scheduling algorithm function
 * @returns {Function} Vehicle-routing-aware scheduling algorithm
 */
function createVehicleRoutingScheduler(baseSchedulingAlgorithm) {
	return function vehicleRoutingAwareScheduler(reservations, driverHours, options = {}) {
		return vehicleRoutingScheduler(reservations, driverHours, baseSchedulingAlgorithm, options);
	};
}

module.exports = {
	vehicleRoutingScheduler,
	createVehicleRoutingScheduler,
	combineSchedulingResults,
};