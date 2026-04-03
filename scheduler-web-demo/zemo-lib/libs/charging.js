/**
 * Charging Utilities for Scheduling
 *
 * This module provides utilities for battery management and charging task creation
 * in driver scheduling algorithms.
 *
 * Key Functions:
 * - analyzeChargingOpportunity: Calculate charging potential during idle time
 * - createChargingTask: Create standardized charging task objects
 * - analyzeScheduleFeasibility: Analyze if a schedule is feasible considering battery constraints
 *
 * See CHARGING_PHILOSOPHY.md for detailed documentation on the charging strategy.
 */

const { getDistance, estimatePointToPointDuration, estimateReservationDuration } = require("./geo");
const { createLogger } = require("./logging");
const Env = require("./environment");
const { populateInternalReservationTime } = require("./reservation");
const momentTZ = require("moment-timezone");
const { TAIPEI_TIMEZONE } = require("../constants/constants");

const logger = createLogger("charging");

/**
 * Analyze charging opportunity during idle time and determine if charging task should be created
 * @param {number} currentRangeKm - Current vehicle range in kilometers
 * @param {number} idleTime - Idle time in seconds
 * @param {boolean} checkBatteryRange - Whether battery range checking is enabled
 * @param {Object} [options] - Optional overrides (e.g. minimumIdleTimeToChargeSeconds for demo)
 * @returns {Object} { updatedRangeKm: number, shouldCreateTask: boolean }
 */
function analyzeChargingOpportunity(currentRangeKm, idleTime, checkBatteryRange, options = {}) {
	let updatedRangeKm = currentRangeKm;
	let shouldCreateTask = false;
	const minIdleSeconds = options.minimumIdleTimeToChargeSeconds ?? Env.minimumIdleTimeToChargeSeconds;

	if (idleTime >= minIdleSeconds) {
		// Calculate potential charging - 1 km per minute minus time to find charging station
		updatedRangeKm += (idleTime - Env.estimatedTimeToFindChargingStationSeconds) / 60;
		if (updatedRangeKm > Env.defaultRangeKm) {
			updatedRangeKm = Env.defaultRangeKm;
		}

		// Determine if charging task should be created (proactive range optimization)
		shouldCreateTask = checkBatteryRange && updatedRangeKm > currentRangeKm;
	}

	return { updatedRangeKm, shouldCreateTask };
}

/**
 * Create a standardized charging task object
 * @param {number} idleTime - Duration of idle time in seconds
 * @param {number} startTime - Start time of the charging task (Unix timestamp)
 * @param {number} rangeBeforeCharge - Vehicle range before charging in kilometers
 * @param {number} rangeAfterCharge - Vehicle range after charging in kilometers
 * @param {Object} [debug] - Optional debug metadata for UI/analysis (does not affect scheduling logic)
 * @returns {Object} Charging task object
 */
function createChargingTask(idleTime, startTime, rangeBeforeCharge, rangeAfterCharge, debug) {
	return {
		type: "charging",
		duration: idleTime,
		startTime: startTime,
		rangeBeforeCharge: rangeBeforeCharge,
		rangeAfterCharge: rangeAfterCharge,
		remainingRangeKm: rangeAfterCharge,
		// 詳細運算過程僅供除錯與前端展示使用，不影響實際排程結果
		chargingDebug: debug || null,
	};
}

/**
 * Create a standardized reservation task object
 * @param {Object} reservation - The reservation object
 * @param {number} distanceKm - Distance of the reservation in kilometers
 * @param {number} remainingRangeKm - Remaining vehicle range after the reservation
 * @returns {Object} Reservation task object
 */
function createReservationTask(reservation, distanceKm, remainingRangeKm) {
	return {
		type: "reservation",
		reservation: reservation,
		startTime: reservation.reservationTime,
		distanceKm: distanceKm,
		remainingRangeKm: remainingRangeKm,
	};
}

/**
 * Analyze a driver's schedule feasibility considering battery constraints and charging opportunities.
 *
 * This function takes a list of reservations and the driver's home location, then determines:
 * a) Whether the driver can complete all reservations considering battery limits and charging opportunities
 * b) A list of tasks (reservation tasks interleaved with charging tasks)
 *
 * The function simulates the driver's day chronologically:
 * - Starting from home with full battery (defaultRangeKm)
 * - For each reservation: calculate transit, check/apply charging, verify battery sufficiency
 * - Track battery consumption and create charging tasks when beneficial
 *
 * @param {Array} reservations - List of reservations (will be sorted by internalReservationTime)
 * @param {Object} homeLocation - Driver's home location { geo: { lat, lng }, address: string }
 * @param {Object} options - Optional configuration
 * @param {number} options.initialRangeKm - Starting battery range (default: Env.defaultRangeKm)
 * @param {number} options.shiftStartTime - When driver's shift starts (unix timestamp)
 * @param {boolean} options.checkBatteryRange - Whether to enforce battery constraints (default: true)
 * @returns {Object} {
 *   isFeasible: boolean,           // Can driver complete all reservations?
 *   tasks: Array,                  // Interleaved charging and reservation tasks
 *   finalRangeKm: number,          // Battery level after completing all reservations
 *   failureReason: string|null,    // If not feasible, explains why
 *   failedAtReservationIndex: number|null,  // Which reservation caused failure
 *   batteryLog: Array              // Detailed battery state transitions for debugging
 * }
 */
function analyzeScheduleFeasibility(reservations, homeLocation, options = {}) {
	const {
		initialRangeKm = Env.defaultRangeKm,
		shiftStartTime = null,
		checkBatteryRange = true,
	} = options;

	// Handle empty reservations
	if (!reservations || reservations.length === 0) {
		return {
			isFeasible: true,
			tasks: [],
			finalRangeKm: initialRangeKm,
			failureReason: null,
			failedAtReservationIndex: null,
			batteryLog: [],
		};
	}

	// Ensure all reservations have internalReservationTime
	// Note: populateInternalReservationTime requires origin.geo to exist
	const processedReservations = reservations.map((r) => {
		if (!r.internalReservationTime) {
			// Skip population if geo data is missing (will be caught later in validation)
			if (!r.origin?.geo) {
				return { ...r, internalReservationTime: r.reservationTime };
			}
			const copy = { ...r };
			populateInternalReservationTime(copy);
			return copy;
		}
		return r;
	});

	// Sort reservations by internalReservationTime
	const sortedReservations = [...processedReservations].sort(
		(a, b) => a.internalReservationTime - b.internalReservationTime
	);

	const tasks = [];
	const batteryLog = [];
	let currentRangeKm = initialRangeKm;
	let currentLocation = homeLocation?.geo || null;
	let currentTime = shiftStartTime || (sortedReservations[0].internalReservationTime - Env.firstReservationBufferSeconds);

	logger.debug(
		{
			reservationCount: sortedReservations.length,
			initialRangeKm,
			hasHomeLocation: !!homeLocation?.geo,
			shiftStartTime: shiftStartTime ? momentTZ.unix(shiftStartTime).tz(TAIPEI_TIMEZONE).format("HH:mm") : null,
		},
		"[analyzeScheduleFeasibility] Starting schedule feasibility analysis"
	);

	for (let i = 0; i < sortedReservations.length; i++) {
		const reservation = sortedReservations[i];
		const reservationTime = reservation.internalReservationTime;

		// Validate reservation has required geo data
		if (!reservation.origin?.geo || !reservation.dest?.geo) {
			logger.warn(
				{ reservationId: reservation.id, index: i },
				"[analyzeScheduleFeasibility] Reservation missing geo data"
			);
			return {
				isFeasible: false,
				tasks,
				finalRangeKm: currentRangeKm,
				failureReason: `Reservation at index ${i} (id: ${reservation.id}) missing origin or destination geo data`,
				failedAtReservationIndex: i,
				batteryLog,
			};
		}

		// Calculate transit distance from current location to reservation pickup
		const transitDistanceKm = currentLocation
			? getDistance(currentLocation, reservation.origin.geo)
			: 0;

		// Calculate transit time
		const transitTimeSeconds = currentLocation
			? estimatePointToPointDuration(currentLocation, reservation.origin.geo, currentTime)
			: 0;

		// Calculate when driver would arrive at pickup location
		const arrivalTime = currentTime + transitTimeSeconds;

		// Calculate idle time between arrival and reservation start
		const idleTimeSeconds = Math.max(0, reservationTime - arrivalTime);

		// Log battery state before this reservation
		batteryLog.push({
			step: `before_reservation_${i}`,
			reservationId: reservation.id,
			currentRangeKm: parseFloat(currentRangeKm.toFixed(2)),
			transitDistanceKm: parseFloat(transitDistanceKm.toFixed(2)),
			idleTimeSeconds,
			idleTimeMinutes: Math.floor(idleTimeSeconds / 60),
			arrivalTime: momentTZ.unix(arrivalTime).tz(TAIPEI_TIMEZONE).format("HH:mm"),
			reservationTime: momentTZ.unix(reservationTime).tz(TAIPEI_TIMEZONE).format("HH:mm"),
		});

		// Analyze charging opportunity during idle time
		const { updatedRangeKm, shouldCreateTask } = analyzeChargingOpportunity(
			currentRangeKm,
			idleTimeSeconds,
			checkBatteryRange
		);

		// Create charging task if beneficial
		if (shouldCreateTask) {
			const chargingTask = createChargingTask(
				idleTimeSeconds,
				arrivalTime,
				currentRangeKm,
				updatedRangeKm
			);
			tasks.push(chargingTask);

			batteryLog.push({
				step: `charging_${i}`,
				reservationId: reservation.id,
				rangeBeforeCharge: parseFloat(currentRangeKm.toFixed(2)),
				rangeAfterCharge: parseFloat(updatedRangeKm.toFixed(2)),
				chargeGainedKm: parseFloat((updatedRangeKm - currentRangeKm).toFixed(2)),
				chargingDurationMinutes: Math.floor(idleTimeSeconds / 60),
			});
		}

		// Update range after potential charging
		const rangeAfterCharging = updatedRangeKm;

		// Calculate reservation trip distance
		const tripDistanceKm = getDistance(reservation.origin.geo, reservation.dest.geo);

		// Total distance needed for this leg (transit + trip)
		const totalDistanceKm = transitDistanceKm + tripDistanceKm;

		// Check if we have enough battery
		if (checkBatteryRange && totalDistanceKm > rangeAfterCharging) {
			logger.info(
				{
					reservationId: reservation.id,
					index: i,
					totalDistanceKm: parseFloat(totalDistanceKm.toFixed(2)),
					availableRangeKm: parseFloat(rangeAfterCharging.toFixed(2)),
					transitDistanceKm: parseFloat(transitDistanceKm.toFixed(2)),
					tripDistanceKm: parseFloat(tripDistanceKm.toFixed(2)),
				},
				"[analyzeScheduleFeasibility] Insufficient battery for reservation"
			);

			return {
				isFeasible: false,
				tasks,
				finalRangeKm: rangeAfterCharging,
				failureReason: `Insufficient battery for reservation at index ${i} (id: ${reservation.id}). ` +
					`Need ${totalDistanceKm.toFixed(2)}km (transit: ${transitDistanceKm.toFixed(2)}km + trip: ${tripDistanceKm.toFixed(2)}km), ` +
					`available: ${rangeAfterCharging.toFixed(2)}km`,
				failedAtReservationIndex: i,
				batteryLog,
			};
		}

		// Calculate remaining range after this reservation
		const remainingRangeKm = rangeAfterCharging - totalDistanceKm;

		// Calculate reservation duration and end time
		const reservationDurationSeconds = estimateReservationDuration(reservation);
		const reservationEndTime = reservationTime + reservationDurationSeconds;

		// Create reservation task
		const reservationTask = createReservationTask(reservation, tripDistanceKm, remainingRangeKm);
		reservationTask.transitDistanceKm = transitDistanceKm;
		reservationTask.totalDistanceKm = totalDistanceKm;
		reservationTask.estimatedEndTime = reservationEndTime;
		tasks.push(reservationTask);

		batteryLog.push({
			step: `after_reservation_${i}`,
			reservationId: reservation.id,
			rangeBeforeTrip: parseFloat(rangeAfterCharging.toFixed(2)),
			transitDistanceKm: parseFloat(transitDistanceKm.toFixed(2)),
			tripDistanceKm: parseFloat(tripDistanceKm.toFixed(2)),
			totalDistanceKm: parseFloat(totalDistanceKm.toFixed(2)),
			remainingRangeKm: parseFloat(remainingRangeKm.toFixed(2)),
		});

		// Update state for next iteration
		currentRangeKm = remainingRangeKm;
		currentLocation = reservation.dest.geo;
		currentTime = reservationEndTime;
	}

	logger.debug(
		{
			isFeasible: true,
			taskCount: tasks.length,
			chargingTaskCount: tasks.filter((t) => t.type === "charging").length,
			reservationTaskCount: tasks.filter((t) => t.type === "reservation").length,
			finalRangeKm: parseFloat(currentRangeKm.toFixed(2)),
		},
		"[analyzeScheduleFeasibility] Schedule feasibility analysis complete"
	);

	return {
		isFeasible: true,
		tasks,
		finalRangeKm: parseFloat(currentRangeKm.toFixed(2)),
		failureReason: null,
		failedAtReservationIndex: null,
		batteryLog,
	};
}

/**
 * Simulate schedule feasibility with a specific set of charging tasks included.
 *
 * This function walks through the tasks in order and simulates battery consumption.
 * Only charging tasks in the `chargingTasksToInclude` set will have their charge applied.
 *
 * @param {Array} tasks - Array of tasks (charging and reservation) in chronological order
 * @param {Set} chargingTasksToInclude - Set of charging task objects to include
 * @param {number} initialRangeKm - Starting battery range
 * @returns {boolean} True if schedule is feasible (battery never goes negative)
 */
function simulateWithChargingTasks(tasks, chargingTasksToInclude, initialRangeKm) {
	let currentRangeKm = initialRangeKm;

	for (const task of tasks) {
		if (task.type === "charging") {
			// Only apply charging if this task is in our inclusion set
			if (chargingTasksToInclude.has(task)) {
				const chargeGain = task.rangeAfterCharge - task.rangeBeforeCharge;
				currentRangeKm = Math.min(currentRangeKm + chargeGain, Env.defaultRangeKm);
			}
		} else if (task.type === "reservation") {
			// Consume battery for this reservation
			const totalDistance = task.totalDistanceKm || (task.transitDistanceKm || 0) + task.distanceKm;
			currentRangeKm -= totalDistance;

			if (currentRangeKm < 0) {
				return false; // Schedule not feasible
			}
		}
	}

	return true; // Schedule is feasible
}

/**
 * Recalculate remainingRangeKm for all tasks after modifying the charging task set.
 *
 * This function walks through tasks in order and updates battery-related fields
 * to reflect the actual state after removing unnecessary charging tasks.
 *
 * @param {Array} tasks - Array of tasks in chronological order
 * @param {number} initialRangeKm - Starting battery range
 * @returns {Array} Tasks with updated remainingRangeKm values
 */
function recalculateRemainingRanges(tasks, initialRangeKm) {
	let currentRangeKm = initialRangeKm;

	return tasks.map((task) => {
		if (task.type === "charging") {
			const chargeGain = task.rangeAfterCharge - task.rangeBeforeCharge;
			// Update rangeBeforeCharge to current range
			const rangeBeforeCharge = currentRangeKm;
			currentRangeKm = Math.min(currentRangeKm + chargeGain, Env.defaultRangeKm);

			return {
				...task,
				rangeBeforeCharge: parseFloat(rangeBeforeCharge.toFixed(2)),
				rangeAfterCharge: parseFloat(currentRangeKm.toFixed(2)),
				remainingRangeKm: parseFloat(currentRangeKm.toFixed(2)),
			};
		} else if (task.type === "reservation") {
			const totalDistance = task.totalDistanceKm || (task.transitDistanceKm || 0) + task.distanceKm;
			currentRangeKm -= totalDistance;

			return {
				...task,
				remainingRangeKm: parseFloat(currentRangeKm.toFixed(2)),
			};
		}
		return task;
	});
}

/**
 * Remove unnecessary charging tasks from a schedule.
 *
 * A charging task is considered unnecessary if the schedule remains feasible
 * (battery never goes negative) without it. Charging tasks are evaluated in
 * order of duration (shortest first) to prioritize removing smaller charging
 * sessions that provide less benefit.
 *
 * Algorithm:
 * 1. Sort charging tasks by duration (ascending)
 * 2. For each charging task (shortest first):
 *    - Temporarily exclude it from the set
 *    - Simulate schedule feasibility with remaining charging tasks
 *    - If feasible, keep it excluded (unnecessary)
 *    - If not feasible, add it back (necessary)
 * 3. Filter out excluded charging tasks
 * 4. Recalculate remainingRangeKm for remaining tasks
 *
 * @param {Array} tasks - Array of tasks from analyzeScheduleFeasibility
 * @param {Object} options - Configuration options
 * @param {number} options.initialRangeKm - Starting battery range (default: Env.defaultRangeKm)
 * @returns {Array} Filtered tasks array with unnecessary charging tasks removed
 */
function removeUnnecessaryChargingTasks(tasks, options = {}) {
	const { initialRangeKm = Env.defaultRangeKm } = options;

	if (!tasks || tasks.length === 0) {
		return tasks;
	}

	// Get all charging tasks
	const chargingTasks = tasks.filter((t) => t.type === "charging");

	if (chargingTasks.length === 0) {
		return tasks;
	}

	// Sort by duration ascending (shortest first)
	const sortedChargingTasks = [...chargingTasks].sort((a, b) => a.duration - b.duration);

	// Start with all charging tasks included
	const chargingTasksToInclude = new Set(chargingTasks);
	const removedTasks = [];

	// Try removing each charging task (shortest first)
	for (const chargingTask of sortedChargingTasks) {
		// Temporarily remove this charging task
		chargingTasksToInclude.delete(chargingTask);

		// Check if schedule is still feasible
		const isFeasible = simulateWithChargingTasks(tasks, chargingTasksToInclude, initialRangeKm);

		if (!isFeasible) {
			// Need this charging task, add it back
			chargingTasksToInclude.add(chargingTask);
		} else {
			// This charging task is unnecessary
			removedTasks.push(chargingTask);
		}
	}

	if (removedTasks.length > 0) {
		logger.info(
			{
				originalChargingTaskCount: chargingTasks.length,
				removedChargingTaskCount: removedTasks.length,
				removedDurationsMinutes: removedTasks.map((t) => Math.floor(t.duration / 60)),
			},
			"[removeUnnecessaryChargingTasks] Removed unnecessary charging tasks"
		);
	}

	// Filter tasks to only include necessary charging tasks
	const filteredTasks = tasks.filter((t) => t.type !== "charging" || chargingTasksToInclude.has(t));

	// Recalculate remainingRangeKm for all tasks
	return recalculateRemainingRanges(filteredTasks, initialRangeKm);
}

module.exports = {
	analyzeChargingOpportunity,
	createChargingTask,
	createReservationTask,
	analyzeScheduleFeasibility,
	simulateWithChargingTasks,
	recalculateRemainingRanges,
	removeUnnecessaryChargingTasks,
};
