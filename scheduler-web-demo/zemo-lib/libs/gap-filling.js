/**
 * Gap Filling Utilities for Scheduling
 *
 * This module provides utilities for filling gaps in driver schedules with new reservations.
 * Used by the hybrid proximity + gap filling scheduling algorithm.
 *
 * Key Functions:
 * - buildScheduleFromExistingAssignments: Build driver schedules from database assignments
 * - findScheduleGaps: Identify time gaps in a driver's schedule
 * - canFitReservationInGap: Check if a reservation can fit in a gap
 * - findBestGapForReservation: Find optimal gap across all drivers
 * - tryGapFillingForReservations: Main entry point for gap-filling algorithm
 */

const _ = require("lodash");
const Env = require("./environment");
const { estimatePointToPointDuration, getDistance, estimateReservationDuration } = require("./geo");
const { isVehicleTypeCompatible, VEHICLE_TYPES } = require("./vehicle-type-utils");
const { populateInternalReservationTime } = require("./reservation");
const {
	createLogger,
	formatUnixTimeToHHMM,
	truncateAddress,
	flattenReservationsForLogging,
} = require("./logging");
const logger = createLogger("gap-filling");
const momentTZ = require("moment-timezone");
const { TAIPEI_TIMEZONE } = require("../constants/constants");
const { LOW_PRIORITY_ENTERPRISES } = require("../constants/enterprise");
const { analyzeScheduleFeasibility } = require("./charging");

/**
 * Check if a reservation time falls within a driver's shift boundaries
 *
 * @param {Object} reservation - Reservation to check
 * @param {Object} driverShift - Driver shift information
 * @param {number} workDayStart - Start of work day (unix timestamp)
 * @returns {boolean} True if reservation is within shift boundaries
 */
function isReservationWithinShift(reservation, driverShift, workDayStart) {
	if (!driverShift || !driverShift.shift) {
		return false;
	}

	const shift = driverShift.shift;
	const dayShiftBeginTime = shift.shiftBeginTime;
	const dayShiftEndTime = shift.shiftEndTime;

	// Calculate shift boundaries in unix time
	const shiftBeginUnix =
		workDayStart +
		dayShiftBeginTime.hour * 3600 +
		dayShiftBeginTime.minute * 60;
	const shiftEndUnix =
		workDayStart +
		(dayShiftEndTime.isoWeekday - dayShiftBeginTime.isoWeekday) * 86400 +
		dayShiftEndTime.hour * 3600 +
		dayShiftEndTime.minute * 60;

	// Use internalReservationTime if available, otherwise use reservationTime
	const reservationTime = reservation.internalReservationTime || reservation.reservationTime;

	return reservationTime >= shiftBeginUnix && reservationTime <= shiftEndUnix;
}

/**
 * Build driver schedules from existing database assignments
 *
 * CRITICAL FIX (2025-01-30): Added shift boundary validation to prevent
 * reservations outside of driver shifts from being included in their schedules.
 * Previously, reservations with pre-assigned driverId were grouped by driver
 * without validating shift boundaries, which could lead to shift violations
 * being carried forward from manual assignments or previous algorithm bugs.
 *
 * @param {Array} existingReservations - Reservations with driverId already assigned
 * @param {Array} driverShifts - Driver shift information
 * @param {Object} options - Optional configuration
 * @param {boolean} options.validateShiftBoundaries - Whether to validate shift boundaries (default: true)
 * @returns {Object} scheduleResult format (driverId -> {reservations, tasks})
 */
function buildScheduleFromExistingAssignments(existingReservations, driverShifts, options = {}) {
	const { validateShiftBoundaries = true } = options;

	logger.info(
		{ existingCount: existingReservations.length, driverCount: driverShifts.length, validateShiftBoundaries },
		"[buildScheduleFromExistingAssignments] Building schedules from existing assignments"
	);

	const scheduleByDriver = {};

	// Initialize empty schedule for all drivers
	driverShifts.forEach((driver) => {
		scheduleByDriver[driver.driverId] = {
			reservations: [],
			tasks: [],
		};
	});

	// Create a map of driver shifts for quick lookup
	const driverShiftMap = new Map();
	driverShifts.forEach((shift) => {
		driverShiftMap.set(shift.driverId, shift);
	});

	// Calculate workDayStart from the first reservation (or current time if no reservations)
	const workDayStart =
		existingReservations.length > 0
			? momentTZ.unix(existingReservations[0].reservationTime).tz(TAIPEI_TIMEZONE).startOf("day").unix()
			: momentTZ().tz(TAIPEI_TIMEZONE).startOf("day").unix();

	// Group reservations by assigned driver
	const reservationsByDriver = _.groupBy(existingReservations, "driverId");

	// Track per-driver schedule details for logging
	const driverScheduleDetails = [];
	const shiftViolations = [];

	for (const [driverId, reservations] of Object.entries(reservationsByDriver)) {
		// Sort by time and ensure internal times are populated
		const sortedReservations = _.sortBy(reservations, "reservationTime");
		sortedReservations.forEach((r) => {
			if (!r.internalReservationTime) {
				populateInternalReservationTime(r);
			}
		});

		// Find the driver's shift
		const driverShift = driverShiftMap.get(parseInt(driverId));

		// Validate shift boundaries if enabled
		let validReservations = sortedReservations;
		if (validateShiftBoundaries && driverShift) {
			validReservations = [];
			for (const reservation of sortedReservations) {
				if (isReservationWithinShift(reservation, driverShift, workDayStart)) {
					validReservations.push(reservation);
				} else {
					// Log shift boundary violation
					const reservationTimeFormatted = momentTZ
						.unix(reservation.internalReservationTime || reservation.reservationTime)
						.tz(TAIPEI_TIMEZONE)
						.format("HH:mm");
					const shiftBegin = `${driverShift.shift.shiftBeginTime.hour}:${String(driverShift.shift.shiftBeginTime.minute).padStart(2, "0")}`;
					const shiftEnd = `${driverShift.shift.shiftEndTime.hour}:${String(driverShift.shift.shiftEndTime.minute).padStart(2, "0")}`;

					shiftViolations.push({
						reservationId: reservation.id,
						driverId: parseInt(driverId),
						reservationTime: reservationTimeFormatted,
						driverShift: `${shiftBegin}-${shiftEnd}`,
						reason: "reservation_outside_shift_boundaries",
					});

					logger.warn(
						{
							reservationId: reservation.id,
							driverId: parseInt(driverId),
							reservationTime: reservationTimeFormatted,
							driverShift: `${shiftBegin}-${shiftEnd}`,
						},
						"[buildScheduleFromExistingAssignments] SHIFT VIOLATION: Reservation outside driver shift boundaries - excluding from schedule"
					);
				}
			}
		}

		scheduleByDriver[driverId] = {
			reservations: validReservations,
			tasks: [], // Tasks can be reconstructed if needed
		};

		// Log detailed schedule for this driver
		driverScheduleDetails.push({
			driverId: parseInt(driverId),
			vehicleType: driverShift?.vehicleType || "STANDARD",
			reservationCount: validReservations.length,
			originalCount: sortedReservations.length,
			excludedCount: sortedReservations.length - validReservations.length,
			// Use helper function to format reservations (returns JSON string to avoid MAX_DEPTH truncation)
			reservationsJson: flattenReservationsForLogging(validReservations),
		});
	}

	// Log summary including any shift violations
	logger.info(
		{
			driversWithReservations: Object.keys(reservationsByDriver).length,
			driversWithoutReservations: driverShifts.length - Object.keys(reservationsByDriver).length,
			driverScheduleDetails,
			shiftViolationsCount: shiftViolations.length,
			shiftViolations: shiftViolations.length > 0 ? shiftViolations : undefined,
		},
		"[buildScheduleFromExistingAssignments] Schedule built with detailed per-driver breakdown"
	);

	return scheduleByDriver;
}

/**
 * Build driver state object from schedule and shift info
 *
 * @param {number} driverId - Driver ID
 * @param {Object} driverSchedule - Current schedule {reservations, tasks}
 * @param {Object} driverShift - Driver shift information
 * @param {number} workDayStart - Start of work day (unix timestamp)
 * @returns {Object} Driver state object
 */
function buildDriverState(driverId, driverSchedule, driverShift, workDayStart) {
	const reservations = driverSchedule.reservations || [];

	const dayShiftBeginTime = driverShift.shift.shiftBeginTime;
	const driverShiftBeginUnix = workDayStart + dayShiftBeginTime.hour * 3600 + dayShiftBeginTime.minute * 60;
	const dayShiftEndTime = driverShift.shift.shiftEndTime;
	const driverShiftEndUnix =
		workDayStart +
		(dayShiftEndTime.isoWeekday - dayShiftBeginTime.isoWeekday) * 86400 +
		dayShiftEndTime.hour * 3600 +
		dayShiftEndTime.minute * 60;

	return {
		driverId: driverId,
		vehicleType: driverShift.vehicleType || VEHICLE_TYPES.STANDARD,
		homeLocation: driverShift.homeLocation,
		shiftBeginUnix: driverShiftBeginUnix,
		shiftEndUnix: driverShiftEndUnix,
		reservations: reservations,
		rangeKm: Env.defaultRangeKm, // Simplified: assume full battery at start
	};
}

/**
 * Find time gaps in a driver's schedule
 *
 * @param {Object} driverState - Driver state object
 * @param {Object} options - Optional logging configuration
 * @returns {Array} Array of gap objects with startTime, endTime, startLocation, type, durationMinutes
 */
function findScheduleGaps(driverState, options = {}) {
	const gaps = [];
	const reservations = driverState.reservations;

	logger.info(
		{
			driverId: driverState.driverId,
			vehicleType: driverState.vehicleType,
			reservationCount: reservations.length,
			shiftStart: formatUnixTimeToHHMM(driverState.shiftBeginUnix),
			shiftEnd: formatUnixTimeToHHMM(driverState.shiftEndUnix),
			options,
		},
		"[findScheduleGaps] Starting gap detection for driver"
	);

	if (reservations.length === 0) {
		// Entire shift is available
		const durationMinutes = Math.floor(
			(driverState.shiftEndUnix - (driverState.shiftBeginUnix - Env.firstReservationBufferSeconds)) / 60
		);
		gaps.push({
			type: "entire_shift",
			startTime: driverState.shiftBeginUnix - Env.firstReservationBufferSeconds,
			endTime: driverState.shiftEndUnix,
			startLocation: driverState.homeLocation?.geo,
			endLocation: null,
			durationMinutes: durationMinutes,
		});
		return gaps;
	}

	// Gap before first reservation
	const firstReservation = reservations[0];
	if (!firstReservation.internalReservationTime) {
		populateInternalReservationTime(firstReservation);
	}

	const gapBeforeFirst =
		firstReservation.internalReservationTime - (driverState.shiftBeginUnix - Env.firstReservationBufferSeconds);

	if (gapBeforeFirst > Env.betweenReservationBufferSeconds) {
		gaps.push({
			type: "before_first",
			startTime: driverState.shiftBeginUnix - Env.firstReservationBufferSeconds,
			endTime: firstReservation.internalReservationTime,
			startLocation: driverState.homeLocation?.geo,
			endLocation: firstReservation.origin.geo,
			durationMinutes: Math.floor(gapBeforeFirst / 60),
			insertIndex: 0, // FIX: Insert at beginning for before_first gaps
		});
	}

	// Gaps between consecutive reservations
	for (let i = 0; i < reservations.length - 1; i++) {
		const currentReservation = reservations[i];
		const nextReservation = reservations[i + 1];

		if (!nextReservation.internalReservationTime) {
			populateInternalReservationTime(nextReservation);
		}

		// Calculate end time using internalReservationTime for consistency
		const currentEndTime = currentReservation.estimatedEndTime ||
			(currentReservation.internalReservationTime || currentReservation.reservationTime) +
			estimateReservationDuration(currentReservation);

		const gapDuration = nextReservation.internalReservationTime - currentEndTime;

		// Only create gap if it's positive and larger than minimum buffer
		if (gapDuration > Env.betweenReservationBufferSeconds) {
			gaps.push({
				type: "between_trips",
				startTime: currentEndTime,
				endTime: nextReservation.internalReservationTime,
				startLocation: currentReservation.dest.geo,
				endLocation: nextReservation.origin.geo,
				durationMinutes: Math.floor(gapDuration / 60),
				afterReservation: currentReservation.id,
				beforeReservation: nextReservation.id,
				insertIndex: i + 1, // Where to insert in reservations array
			});
		} else if (gapDuration < 0) {
			// Log warning when reservations overlap
			logger.warn(
				{
					currentReservationId: currentReservation.id,
					nextReservationId: nextReservation.id,
					currentEndTime: formatUnixTimeToHHMM(currentEndTime),
					nextStartTime: formatUnixTimeToHHMM(nextReservation.internalReservationTime),
					overlapSeconds: -gapDuration,
				},
				"[findScheduleGaps] Overlapping reservations detected - skipping gap creation"
			);
		}
	}

	// Gap after last reservation
	const lastReservation = reservations[reservations.length - 1];
	// Use internalReservationTime for consistency
	const lastEndTime = lastReservation.estimatedEndTime ||
		(lastReservation.internalReservationTime || lastReservation.reservationTime) +
		estimateReservationDuration(lastReservation);

	const gapAfterLast = driverState.shiftEndUnix - lastEndTime;

	if (gapAfterLast > Env.betweenReservationBufferSeconds) {
		gaps.push({
			type: "after_last",
			startTime: lastEndTime,
			endTime: driverState.shiftEndUnix,
			startLocation: lastReservation.dest.geo,
			endLocation: null,
			durationMinutes: Math.floor(gapAfterLast / 60),
			insertIndex: reservations.length,
		});
	}

	// Log comprehensive gap summary
	const gapSummary = {
		driverId: driverState.driverId,
		totalGapsFound: gaps.length,
		gapsByType: {
			entire_shift: gaps.filter((g) => g.type === "entire_shift").length,
			before_first: gaps.filter((g) => g.type === "before_first").length,
			between_trips: gaps.filter((g) => g.type === "between_trips").length,
			after_last: gaps.filter((g) => g.type === "after_last").length,
		},
		totalGapMinutes: gaps.reduce((sum, g) => sum + g.durationMinutes, 0),
		gaps: gaps.map((g) => ({
			type: g.type,
			startTime: formatUnixTimeToHHMM(g.startTime),
			endTime: formatUnixTimeToHHMM(g.endTime),
			durationMinutes: g.durationMinutes,
			insertIndex: g.insertIndex,
			afterReservation: g.afterReservation,
			beforeReservation: g.beforeReservation,
		})),
	};

	logger.info(
		{
			gapSummary,
			options,
		},
		"[findScheduleGaps] Gap detection complete"
	);

	return gaps;
}

/**
 * Check if a reservation can fit in a gap
 *
 * CRITICAL FIX (2025-12-17): Added boundary check to ensure reservation's pickup time
 * falls within the gap period. Previous logic would incorrectly accept reservations
 * scheduled outside the gap (e.g., 9 PM reservation inserted into 5-7 AM gap).
 *
 * @param {Object} reservation - Reservation to check
 * @param {Object} gap - Gap object with startTime, endTime, startLocation, endLocation
 * @param {Object} driverState - Driver state object
 * @returns {Object|null} Fit info if fits, null if doesn't fit
 */
function canFitReservationInGap(reservation, gap, driverState) {
	// Ensure reservation has internal reservation time
	if (!reservation.internalReservationTime) {
		populateInternalReservationTime(reservation);
	}

	// Validate gap is positive (end time > start time)
	if (gap.endTime <= gap.startTime) {
		logger.warn(
			{
				gapType: gap.type,
				gapStart: formatUnixTimeToHHMM(gap.startTime),
				gapEnd: formatUnixTimeToHHMM(gap.endTime),
			},
			"[canFitReservationInGap] Invalid gap - end time not after start time"
		);
		return null;
	}

	// CRITICAL CHECK: Reservation's pickup time must fall within gap boundaries
	// This prevents inserting reservations scheduled for completely different times
	// (e.g., evening reservation into morning gap)
	if (reservation.internalReservationTime < gap.startTime ||
	    reservation.internalReservationTime > gap.endTime) {
		logger.debug(
			{
				reservationTime: momentTZ.unix(reservation.internalReservationTime).tz(TAIPEI_TIMEZONE).format("YYYY-MM-DD HH:mm"),
				gapStart: momentTZ.unix(gap.startTime).tz(TAIPEI_TIMEZONE).format("YYYY-MM-DD HH:mm"),
				gapEnd: momentTZ.unix(gap.endTime).tz(TAIPEI_TIMEZONE).format("YYYY-MM-DD HH:mm"),
				gapType: gap.type,
			},
			"[canFitReservationInGap] Reservation pickup time outside gap boundaries"
		);
		return null;
	}

	// Check vehicle type compatibility
	if (!isVehicleTypeCompatible(driverState.vehicleType, reservation.requiredVehicleType)) {
		return null;
	}

	// Validate reservation has required geo data - prevent null access errors
	if (!reservation.origin || !reservation.origin.geo || !reservation.dest || !reservation.dest.geo) {
		logger.error(
			{
				reservationId: reservation.id,
				hasOrigin: !!reservation.origin,
				hasOriginGeo: !!(reservation.origin && reservation.origin.geo),
				hasDest: !!reservation.dest,
				hasDestGeo: !!(reservation.dest && reservation.dest.geo),
			},
			"[canFitReservationInGap] Reservation missing required geo data"
		);
		return null;
	}

	// Calculate transit time from gap start to reservation origin
	const transitTime = gap.startLocation
		? estimatePointToPointDuration(gap.startLocation, reservation.origin.geo, gap.startTime)
		: 0;

	const arrivalTime = gap.startTime + transitTime + Env.betweenReservationBufferSeconds;

	// Check if driver can arrive before scheduled pickup time
	// Driver must be able to reach pickup location from gap start location
	if (arrivalTime > reservation.internalReservationTime) {
		logger.debug(
			{
				arrivalTime: formatUnixTimeToHHMM(arrivalTime),
				pickupTime: formatUnixTimeToHHMM(reservation.internalReservationTime),
				transitMinutes: Math.floor(transitTime / 60),
			},
			"[canFitReservationInGap] Driver cannot arrive before pickup time"
		);
		return null;
	}

	// Calculate when the reservation actually ends (using scheduled pickup time)
	const reservationDuration = estimateReservationDuration(reservation);
	const actualReservationEndTime = reservation.internalReservationTime + reservationDuration;

	// Calculate transit to next location using ACTUAL end time (not gap-relative time)
	// This ensures we check if driver can reach next reservation from where this one ends
	let transitToNext = 0;
	if (gap.endLocation) {
		transitToNext = estimatePointToPointDuration(
			reservation.dest.geo,
			gap.endLocation,
			actualReservationEndTime  // Use actual end time, not gap.startTime
		);
	}

	// Check if driver can complete this reservation and reach next reservation on time
	// This is the arrival time at the NEXT reservation's pickup location
	const arrivalAtNextReservation = actualReservationEndTime + transitToNext + Env.betweenReservationBufferSeconds;

	// For gaps with a next reservation (between_trips, before_first), enforce strict timing
	// For gaps without a next reservation (after_last), allow reservation to extend past shift end
	// as long as the pickup time is before shift end
	if (gap.endLocation && arrivalAtNextReservation > gap.endTime) {
		logger.debug(
			{
				reservationEnd: formatUnixTimeToHHMM(actualReservationEndTime),
				transitMinutes: Math.floor(transitToNext / 60),
				arrivalAtNext: formatUnixTimeToHHMM(arrivalAtNextReservation),
				nextReservationStart: formatUnixTimeToHHMM(gap.endTime),
				gapType: gap.type,
			},
			"[canFitReservationInGap] Cannot reach next reservation on time"
		);
		return null;
	}

	// For after_last gaps, log if reservation extends past shift end
	if (!gap.endLocation && actualReservationEndTime > gap.endTime) {
		logger.info(
			{
				reservationId: reservation.id,
				pickupTime: formatUnixTimeToHHMM(reservation.internalReservationTime),
				reservationEnd: formatUnixTimeToHHMM(actualReservationEndTime),
				shiftEnd: formatUnixTimeToHHMM(gap.endTime),
				overtimeMinutes: Math.floor((actualReservationEndTime - gap.endTime) / 60),
				gapType: gap.type,
			},
			"[canFitReservationInGap] Reservation extends past shift end but starts before shift end - allowing"
		);
	}

	// Calculate distances
	const distanceToReservation = gap.startLocation ? getDistance(gap.startLocation, reservation.origin.geo) : 0;
	const reservationDistance = getDistance(reservation.origin.geo, reservation.dest.geo);
	const totalDistance = distanceToReservation + reservationDistance;

	// Battery range check
	if (totalDistance > driverState.rangeKm) {
		logger.debug(
			{
				totalDistanceKm: totalDistance.toFixed(2),
				rangeKm: driverState.rangeKm,
			},
			"[canFitReservationInGap] Insufficient battery range"
		);
		return null;
	}

	// Calculate remaining gap time (for optimization - prefer tighter fits)
	const remainingGapTime = gap.endTime - arrivalAtNextReservation;

	return {
		arrivalTime: arrivalTime,
		reservationEndTime: actualReservationEndTime,
		transitTime: transitTime,
		transitToNext: transitToNext,
		arrivalAtNextReservation: arrivalAtNextReservation,
		remainingGapTime: remainingGapTime,
		distanceToReservation: distanceToReservation,
		reservationDistance: reservationDistance,
		totalDistance: totalDistance,
	};
}

/**
 * Validate that a driver's schedule is feasible with battery constraints after inserting a reservation.
 *
 * This creates a hypothetical schedule with the new reservation inserted and validates
 * that the driver can complete all reservations considering battery limits and charging opportunities.
 *
 * @param {Object} reservation - Reservation to insert
 * @param {Object} driverSchedule - Current driver schedule {reservations, tasks}
 * @param {Object} driverState - Driver state object with homeLocation
 * @param {Object} gap - Gap where reservation would be inserted
 * @returns {Object} { isFeasible: boolean, reason: string|null }
 */
function validateScheduleWithBattery(reservation, driverSchedule, driverState, gap) {
	// Create hypothetical schedule with reservation inserted
	const hypotheticalReservations = [...driverSchedule.reservations];

	// Ensure reservation has internalReservationTime
	if (!reservation.internalReservationTime) {
		populateInternalReservationTime(reservation);
	}

	// Insert at the correct position
	const insertIndex = gap.insertIndex !== undefined ? gap.insertIndex : hypotheticalReservations.length;
	hypotheticalReservations.splice(insertIndex, 0, reservation);

	// Sort by time to ensure correct order
	hypotheticalReservations.sort((a, b) => {
		const timeA = a.internalReservationTime || a.reservationTime;
		const timeB = b.internalReservationTime || b.reservationTime;
		return timeA - timeB;
	});

	// Validate the full schedule with battery constraints
	const feasibilityResult = analyzeScheduleFeasibility(
		hypotheticalReservations,
		driverState.homeLocation,
		{
			initialRangeKm: Env.defaultRangeKm,
			shiftStartTime: driverState.shiftBeginUnix,
			checkBatteryRange: true,
		}
	);

	if (!feasibilityResult.isFeasible) {
		logger.debug(
			{
				driverId: driverState.driverId,
				reservationId: reservation.id,
				failureReason: feasibilityResult.failureReason,
				failedAtIndex: feasibilityResult.failedAtReservationIndex,
				hypotheticalReservationCount: hypotheticalReservations.length,
			},
			"[validateScheduleWithBattery] Schedule infeasible with new reservation"
		);
	}

	return {
		isFeasible: feasibilityResult.isFeasible,
		reason: feasibilityResult.failureReason,
		finalRangeKm: feasibilityResult.finalRangeKm,
		tasks: feasibilityResult.tasks,
	};
}

/**
 * Find the best gap for a reservation across all drivers
 *
 * @param {Object} reservation - Reservation to fit
 * @param {Object} scheduleByDriver - Current schedules (driverId -> {reservations, tasks})
 * @param {Array} driverShifts - Driver shift information
 * @param {number} workDayStart - Start of work day (unix timestamp)
 * @param {Object} options - Optional logging configuration
 * @param {boolean} options.skipBatteryValidation - Skip full battery validation (default: use Env.enableGapFillingBatteryValidation)
 * @returns {Object|null} {driverId, gap, fitInfo} or null if no suitable gap found
 */
function findBestGapForReservation(reservation, scheduleByDriver, driverShifts, workDayStart, options = {}) {
	// Use feature flag to determine if battery validation is enabled
	// skipBatteryValidation option can override the flag (true = skip, false = use flag)
	const skipBatteryValidation = options.skipBatteryValidation !== undefined 
		? options.skipBatteryValidation 
		: !Env.enableGapFillingBatteryValidation;

	logger.info(
		{
			reservationId: reservation.id,
			reservationTime: formatUnixTimeToHHMM(reservation.reservationTime),
			internalReservationTime: formatUnixTimeToHHMM(reservation.internalReservationTime),
			origin: truncateAddress(reservation.origin?.address),
			destination: truncateAddress(reservation.dest?.address),
			enterpriseId: reservation.enterpriseId,
			requiredVehicleType: reservation.requiredVehicleType || "any",
			skipBatteryValidation,
			options,
		},
		"[findBestGapForReservation] Searching for best gap across all drivers"
	);

	let bestFit = null;
	let smallestRemainingGap = Infinity;

	// Track all gap evaluations for debugging
	const gapEvaluations = [];
	let totalGapsEvaluated = 0;
	let batteryValidationFailures = 0;

	for (const driverShift of driverShifts) {
		const driverId = driverShift.driverId;
		const driverSchedule = scheduleByDriver[driverId];

		if (!driverSchedule) {
			continue;
		}

		const driverState = buildDriverState(driverId, driverSchedule, driverShift, workDayStart);
		const gaps = findScheduleGaps(driverState, options);

		totalGapsEvaluated += gaps.length;

		for (const gap of gaps) {
			const fitInfo = canFitReservationInGap(reservation, gap, driverState);

			const evaluation = {
				driverId,
				vehicleType: driverState.vehicleType,
				gapType: gap.type,
				gapStart: formatUnixTimeToHHMM(gap.startTime),
				gapEnd: formatUnixTimeToHHMM(gap.endTime),
				gapDurationMinutes: gap.durationMinutes,
				fits: !!fitInfo,
				batteryFeasible: null,
			};

			if (fitInfo) {
				// Validate full schedule with battery constraints
				let batteryValidation = { isFeasible: true };
				if (!skipBatteryValidation) {
					batteryValidation = validateScheduleWithBattery(
						reservation,
						driverSchedule,
						driverState,
						gap
					);
					evaluation.batteryFeasible = batteryValidation.isFeasible;

					if (!batteryValidation.isFeasible) {
						batteryValidationFailures++;
						evaluation.batteryFailureReason = batteryValidation.reason;
						gapEvaluations.push(evaluation);
						continue; // Skip this gap - battery validation failed
					}
				}

				evaluation.remainingGapMinutes = Math.floor(fitInfo.remainingGapTime / 60);
				evaluation.arrivalTime = formatUnixTimeToHHMM(fitInfo.arrivalTime);
				evaluation.isBestSoFar = fitInfo.remainingGapTime < smallestRemainingGap;

				if (fitInfo.remainingGapTime < smallestRemainingGap) {
					smallestRemainingGap = fitInfo.remainingGapTime;
					bestFit = {
						driverId: driverId,
						gap: gap,
						fitInfo: fitInfo,
						driverState: driverState,
						batteryValidation: batteryValidation,
					};
				}
			}

			gapEvaluations.push(evaluation);
		}
	}

	// Log summary of gap evaluation
	const summary = {
		reservationId: reservation.id,
		totalDriversEvaluated: driverShifts.length,
		totalGapsEvaluated,
		fittingGapsFound: gapEvaluations.filter((e) => e.fits).length,
		batteryValidationFailures,
		bestFitFound: !!bestFit,
	};

	if (bestFit) {
		summary.bestFit = {
			driverId: bestFit.driverId,
			vehicleType: bestFit.driverState.vehicleType,
			gapType: bestFit.gap.type,
			remainingGapMinutes: Math.floor(bestFit.fitInfo.remainingGapTime / 60),
			utilizationPercent: (
				((bestFit.gap.durationMinutes - Math.floor(bestFit.fitInfo.remainingGapTime / 60)) /
					bestFit.gap.durationMinutes) *
				100
			).toFixed(1),
			finalBatteryRangeKm: bestFit.batteryValidation?.finalRangeKm,
		};
	}

	logger.info(
		{
			summary,
			gapEvaluations,
			options,
		},
		bestFit
			? "[findBestGapForReservation] Best gap found"
			: "[findBestGapForReservation] No suitable gap found"
	);

	return bestFit;
}

/**
 * Insert a reservation into a driver's schedule
 *
 * @param {Object} reservation - Reservation to insert
 * @param {Object} bestFit - Best fit result from findBestGapForReservation
 * @param {Object} scheduleByDriver - Current schedules to update
 * @returns {void} Modifies scheduleByDriver in place
 */
function insertReservationIntoSchedule(reservation, bestFit, scheduleByDriver) {
	const { driverId, gap, fitInfo } = bestFit;
	const driverSchedule = scheduleByDriver[driverId];

	// Update reservation with assignment
	reservation.driverId = driverId;
	reservation.estimatedEndTime = fitInfo.reservationEndTime;
	reservation.estimatedEndTimeHumanReadable = momentTZ
		.unix(reservation.estimatedEndTime)
		.tz(TAIPEI_TIMEZONE)
		.format("YYYY-MM-DD HH:mm");

	// Ensure reservation has internalReservationTime for sorting
	if (!reservation.internalReservationTime) {
		populateInternalReservationTime(reservation);
	}

	// Insert at appropriate position
	const insertIndex = gap.insertIndex !== undefined ? gap.insertIndex : driverSchedule.reservations.length;
	driverSchedule.reservations.splice(insertIndex, 0, reservation);

	// FIX: Re-sort reservations by time after each insertion to maintain chronological order
	// This prevents schedule corruption when insertIndex is incorrect or when multiple
	// reservations are inserted in non-chronological order
	driverSchedule.reservations.sort((a, b) => {
		const timeA = a.internalReservationTime || a.reservationTime;
		const timeB = b.internalReservationTime || b.reservationTime;
		return timeA - timeB;
	});

	logger.info(
		{
			driverId,
			reservationId: reservation.id,
			insertIndex,
			gapType: gap.type,
			gap,
			arrivalTime: formatUnixTimeToHHMM(fitInfo.arrivalTime),
			endTime: formatUnixTimeToHHMM(fitInfo.reservationEndTime),
		},
		"[insertReservationIntoSchedule] Reservation inserted into gap"
	);
}

/**
 * Main gap-filling algorithm entry point
 *
 * Attempts to fit new reservations into existing driver schedules by finding and filling gaps.
 *
 * @param {Array} newReservations - New reservations to fit (without driverId)
 * @param {Object} scheduleByDriver - Existing schedules (driverId -> {reservations, tasks})
 * @param {Array} driverShifts - Driver shift information
 * @param {number} workDayStart - Start of work day (unix timestamp)
 * @returns {Object} {success: boolean, updatedSchedule: Object, assignedReservations: Array, failedReservations: Array}
 */
function tryGapFillingForReservations(newReservations, scheduleByDriver, driverShifts, workDayStart, options = {}) {
	try {
		logger.info(
			{ newReservationsCount: newReservations.length, options },
			"[tryGapFillingForReservations] Starting gap-filling for new reservations"
		);

		// Clone schedule to avoid modifying original
		const updatedSchedule = _.cloneDeep(scheduleByDriver);

		// CRITICAL FIX (2025-01-30): Initialize empty schedules for all drivers not already in the schedule
		// This ensures drivers with no existing assignments are still considered for gap-filling.
		// Without this fix, drivers without any reservations would be skipped entirely in findBestGapForReservation
		// because they wouldn't have an entry in scheduleByDriver.
		let driversInitialized = 0;
		for (const driverShift of driverShifts) {
			if (!updatedSchedule[driverShift.driverId]) {
				updatedSchedule[driverShift.driverId] = {
					reservations: [],
					tasks: [],
				};
				driversInitialized++;
			}
		}
		if (driversInitialized > 0) {
			logger.info(
				{
					driversInitialized,
					totalDrivers: driverShifts.length,
					existingDriversInSchedule: driverShifts.length - driversInitialized,
					options,
				},
				"[tryGapFillingForReservations] Initialized empty schedules for drivers without existing assignments"
			);
		}

	const assignedReservations = [];
	const failedReservations = [];

	// Sort by priority (high first), then by distance (longer first), then by time (earlier first)
	// FIX: Added time-based sorting as tertiary criteria to ensure consistent processing order
	const sortedReservations = _.orderBy(
		newReservations,
		[
			(r) => !LOW_PRIORITY_ENTERPRISES.has(r.enterpriseId), // High priority first
			"estimatedDistance", // Longer distance first
			(r) => r.internalReservationTime || r.reservationTime, // Earlier time first
		],
		["desc", "desc", "asc"]
	);

	// Clear old driverId from evicted reservations before gap-filling attempts
	// This ensures in-memory state matches expected database state after eviction
	for (const reservation of sortedReservations) {
		if (reservation.driverId != null) {
			logger.info(
				{
					reservationId: reservation.id,
					oldDriverId: reservation.driverId,
					enterpriseId: reservation.enterpriseId,
					options,
				},
				"[tryGapFillingForReservations] Clearing old driverId from evicted reservation before gap-filling"
			);
			// Save old value for audit trail
			reservation.oldDriverId = reservation.driverId;
			reservation.driverId = null;
		}
	}

	for (const reservation of sortedReservations) {
		try {
			const bestFit = findBestGapForReservation(reservation, updatedSchedule, driverShifts, workDayStart, options);

			if (bestFit) {
				insertReservationIntoSchedule(reservation, bestFit, updatedSchedule);
				assignedReservations.push(reservation);

				logger.info(
					{
						reservationId: reservation.id,
						driverId: bestFit.driverId,
						gapType: bestFit.gap.type,
						options,
					},
					"[tryGapFillingForReservations] Reservation gap-filled successfully"
				);
			} else {
				failedReservations.push(reservation);

				logger.info(
					{
						reservationId: reservation.id,
						requiredVehicleType: reservation.requiredVehicleType,
						options,
					},
					"[tryGapFillingForReservations] Reservation could not be gap-filled"
				);
			}
		} catch (error) {
			logger.error(
				{
					error,
					reservationId: reservation.id,
					options,
				},
				"[tryGapFillingForReservations] Error during gap-filling for individual reservation"
			);
			// Add to failed reservations and continue with others
			failedReservations.push(reservation);
		}
	}

	const success = failedReservations.length === 0;

	logger.info(
		{
			assigned: assignedReservations.length,
			failed: failedReservations.length,
			successRate: ((assignedReservations.length / newReservations.length) * 100).toFixed(1) + "%",
			options,
		},
		"[tryGapFillingForReservations] Gap-filling complete"
	);

	return {
		success: success,
		updatedSchedule: updatedSchedule,
		assignedReservations: assignedReservations,
		failedReservations: failedReservations,
	};
	} catch (error) {
		logger.error(
			{
				error,
				options,
				newReservationsCount: newReservations.length,
			},
			"[tryGapFillingForReservations] Critical error in gap-filling"
		);
		throw error;
	}
}

module.exports = {
	buildScheduleFromExistingAssignments,
	buildDriverState,
	findScheduleGaps,
	canFitReservationInGap,
	findBestGapForReservation,
	insertReservationIntoSchedule,
	tryGapFillingForReservations,
	validateScheduleWithBattery,
	isReservationWithinShift,
};
