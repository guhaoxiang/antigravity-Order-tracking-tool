// "PROXIMITY" scheduling algorithm
//
// 1. Sorts reservations by time ascending
// 2. Initializes all drivers with their starting state (home location, available time)
// 3. For each reservation (in chronological order):
//    - Finds all eligible drivers who can reach the reservation on time
//    - Selects the closest available driver based on distance
//    - Assigns the reservation to that driver
//    - Updates the driver's location and availability

// ### Characteristics:
// - Reservation-centric approach: considers all drivers for each reservation
// - Proximity-based assignment: chooses the closest available driver
// - Dynamic driver state tracking: updates location after each assignment
// - Better geographical optimization

const _ = require("lodash");
const moment = require("moment");
const momentTZ = require("moment-timezone");

const { TAIPEI_TIMEZONE } = require("../constants/constants");
const { RELIEF_DRIVER_IDS, SECONDARY_DRIVER_IDS } = require("../constants/drivers");
const { estimateReservationDuration, estimatePointToPointDuration, getDistance, getPointToPointDurationBreakdown } = require("./geo");
const { createLogger } = require("./logging");
const { populateInternalReservationTime } = require("./reservation");
const Env = require("./environment");
const metrics = require("./metrics");
const {
	createProximityHomeLocationLookup,
	createScheduleResultWithNonTripDistances,
	analyzeChargingOpportunity,
	createChargingTask,
	createReservationTask,
} = require("./schedule-utils");
const { enhanceAlgorithmResponse } = require("./algorithm-response-enhancer");
const { isVehicleTypeCompatible, VEHICLE_TYPES } = require("./vehicle-type-utils");

const logger = createLogger("proximity");

/**
 * Initialize driver state for tracking their current location and time
 */
function initializeDriverStates(driverHours, workDayStart) {
	const driverStates = {};

	// Track how many shift entries each driver has, to generate unique keys for split shifts
	const shiftCountByDriver = {};

	for (let hour of driverHours) {
		const dayShiftBeginTime = hour.shift.shiftBeginTime;
		const driverShiftBeginUnix = workDayStart
			.clone()
			.add(dayShiftBeginTime.hour, "h")
			.add(dayShiftBeginTime.minute, "m")
			.unix();
		const dayShiftEndTime = hour.shift.shiftEndTime;
		const driverShiftEndUnix = workDayStart
			.clone()
			.add(dayShiftEndTime.isoWeekday - dayShiftBeginTime.isoWeekday, "d")
			.add(dayShiftEndTime.hour, "h")
			.add(dayShiftEndTime.minute, "m")
			.unix();

		// Track last known location and time for each driver
		// Time at last known location is shift start time minus firstReservationBufferSeconds
		const timeAtLastKnownLocation = driverShiftBeginUnix - Env.firstReservationBufferSeconds;

		// Use composite key for split shifts (e.g., "286_0", "286_1")
		const did = hour.driverId;
		const idx = shiftCountByDriver[did] || 0;
		shiftCountByDriver[did] = idx + 1;
		const stateKey = idx === 0 ? String(did) : `${did}_${idx}`;

		driverStates[stateKey] = {
			driverId: did,
			vehicleType: hour.vehicleType || VEHICLE_TYPES.STANDARD,
			lastKnownLocation: hour.homeLocation?.geo || null,
			lastKnownAddress: hour.homeLocation?.address || null,
			timeAtLastKnownLocation: timeAtLastKnownLocation,
			driverShiftBeginUnix: driverShiftBeginUnix,
			driverShiftEndUnix: driverShiftEndUnix,
			homeLocation: hour.homeLocation,
			reservationSequence: [],
			taskSequence: [],
			rangeKm: Env.defaultRangeKm,
		};
	}

	return driverStates;
}

/**
 * Find the best driver for a given reservation based on proximity and availability
 */
function findBestDriverForReservation(reservation, driverStates, options = {}) {
	let bestDriver = null;
	let shortestDistance = Infinity;

	// Track best drivers by priority level
	let bestRegularDriver = null;
	let bestSecondaryDriver = null;
	let bestReliefDriver = null;
	let shortestRegularDistance = Infinity;
	let shortestSecondaryDistance = Infinity;
	let shortestReliefDistance = Infinity;

	logger.info(
		{ schedulingAlgorithm: "proximity", reservationId: reservation.id, options },
		`🔍 [PROXIMITY] Evaluating drivers for reservation ${reservation.id} (${moment
			.unix(reservation.reservationTime)
			.tz(TAIPEI_TIMEZONE)
			.format("YYYY-MM-DD HH:mm")})`
	);
	logger.info(
		{ schedulingAlgorithm: "proximity", reservationId: reservation.id, options },
		`📍 Reservation origin: ${reservation.origin.address} (${reservation.origin.geo.lat.toFixed(
			4
		)}, ${reservation.origin.geo.lng.toFixed(4)})`
	);

	for (const [driverId, driverState] of Object.entries(driverStates)) {
		// Determine driver priority level (use driverState.driverId for split-shift composite keys)
		const realDriverId = driverState.driverId;
		const isReliefDriver = RELIEF_DRIVER_IDS.includes(parseInt(realDriverId));
		const isSecondaryDriver = SECONDARY_DRIVER_IDS.includes(parseInt(realDriverId));
		const isRegularDriver = !isReliefDriver && !isSecondaryDriver;

		// 永遠檢查車型相容性：五人座司機不可接七人座訂單
		if (!isVehicleTypeCompatible(driverState.vehicleType, reservation.requiredVehicleType)) {
			logger.info(
				{ schedulingAlgorithm: "proximity", driverId, reservationId: reservation.id, options },
				`❌ Driver ${driverId} (${
					isRegularDriver ? "Regular" : isSecondaryDriver ? "Secondary" : "Relief"
				}): Vehicle type incompatible (driver: ${driverState.vehicleType}, required: ${
					reservation.requiredVehicleType || "any"
				})`
			);
			continue;
		}

		// Check if driver is within their shift time
		if (
			reservation.reservationTime < driverState.driverShiftBeginUnix ||
			reservation.reservationTime > driverState.driverShiftEndUnix
		) {
			logger.info(
				{ schedulingAlgorithm: "proximity", driverId, reservationId: reservation.id, options },
				`❌ Driver ${driverId} (${
					isRegularDriver ? "Regular" : isSecondaryDriver ? "Secondary" : "Relief"
				}): Outside shift hours (${moment
					.unix(driverState.driverShiftBeginUnix)
					.tz(TAIPEI_TIMEZONE)
					.format("HH:mm")} - ${moment
					.unix(driverState.driverShiftEndUnix)
					.tz(TAIPEI_TIMEZONE)
					.format("HH:mm")})`
			);
			continue;
		}

		let transitTime;
		// Calculate transit time from driver's last known location to reservation origin
		if (driverState.lastKnownLocation === null) {
			logger.info(
				{ schedulingAlgorithm: "proximity", driverId, reservationId: reservation.id, options },
				`❌ Driver ${driverId} (${
					isRegularDriver ? "Regular" : isSecondaryDriver ? "Secondary" : "Relief"
				}): No last known location`
			);
			transitTime = 0;
		} else {
			transitTime = estimatePointToPointDuration(
				driverState.lastKnownLocation,
				reservation.origin.geo,
				driverState.timeAtLastKnownLocation
			);
		}

		// Add buffer time for subsequent reservations
		if (driverState.reservationSequence.length > 0) {
			transitTime += Env.betweenReservationBufferSeconds;
		}

		if (driverState.lastKnownLocation !== null) {
			logger.info(
				{ schedulingAlgorithm: "proximity", driverId, reservationId: reservation.id, options },
				`🚗 Driver ${driverId} (${
					isRegularDriver ? "Regular" : isSecondaryDriver ? "Secondary" : "Relief"
				}): Current location (${driverState.lastKnownLocation.lat.toFixed(
					4
				)}, ${driverState.lastKnownLocation.lng.toFixed(4)}), ${driverState.lastKnownAddress}`
			);
		}
		logger.info(
			{ schedulingAlgorithm: "proximity", driverId, reservationId: reservation.id, options },
			`⏱️  Driver ${driverId} (${
				isRegularDriver ? "Regular" : isSecondaryDriver ? "Secondary" : "Relief"
			}): Transit time ${Math.round(transitTime / 60)}min, Base transit: ${Math.round(
				(transitTime - (driverState.reservationSequence.length > 0 ? Env.betweenReservationBufferSeconds : 0)) /
					60
			)}min`
		);

		// Check if driver can make it to the reservation on time
		const arrivalTime = driverState.timeAtLastKnownLocation + transitTime;
		const canMakeIt = arrivalTime <= reservation.internalReservationTime;

		if (!canMakeIt) {
			logger.info(
				{ schedulingAlgorithm: "proximity", driverId, reservationId: reservation.id, options },
				`❌ Driver ${driverId} (${
					isRegularDriver ? "Regular" : isSecondaryDriver ? "Secondary" : "Relief"
				}): Cannot arrive on time (arrival: ${moment
					.unix(arrivalTime)
					.tz(TAIPEI_TIMEZONE)
					.format("HH:mm")}, reservation: ${moment
					.unix(reservation.internalReservationTime)
					.tz(TAIPEI_TIMEZONE)
					.format("HH:mm")})`
			);
			continue;
		}

		// Calculate distance to determine closest driver
		const distanceToReservation = driverState.lastKnownLocation === null ? 0 : getDistance(driverState.lastKnownLocation, reservation.origin.geo);

		// Check battery range if enabled
		const reservationDistanceKm = getDistance(reservation.origin.geo, reservation.dest.geo);
		const totalDistanceKm = distanceToReservation + reservationDistanceKm;

		logger.info(
			{ schedulingAlgorithm: "proximity", driverId, reservationId: reservation.id, options },
			`📏 Driver ${driverId} (${
				isRegularDriver ? "Regular" : isSecondaryDriver ? "Secondary" : "Relief"
			}): Distance to reservation: ${distanceToReservation.toFixed(
				2
			)}km, Reservation distance: ${reservationDistanceKm.toFixed(2)}km, Total: ${totalDistanceKm.toFixed(2)}km`
		);

		// Calculate idle time and analyze charging opportunity
		const idleTime = reservation.internalReservationTime - arrivalTime;
		const { updatedRangeKm } = analyzeChargingOpportunity(driverState.rangeKm, idleTime, true);

		// Skip if not enough battery range
		if (totalDistanceKm > updatedRangeKm) {
			logger.info(
				{ schedulingAlgorithm: "proximity", driverId, reservationId: reservation.id, options },
				`❌ Driver ${driverId} (${
					isRegularDriver ? "Regular" : isSecondaryDriver ? "Secondary" : "Relief"
				}): Insufficient battery range (needed: ${totalDistanceKm.toFixed(
					2
				)}km, available: ${updatedRangeKm.toFixed(2)}km)`
			);
			continue;
		}

		// Track best driver by priority level
		const driverMatch = {
			driverId: driverId,
			driverState: driverState,
			transitTime: transitTime,
			distanceToReservation: distanceToReservation,
			totalDistanceKm: totalDistanceKm,
			updatedRangeKm: updatedRangeKm,
			idleTime: idleTime,
		};

		if (isRegularDriver) {
			if (distanceToReservation < shortestRegularDistance) {
				shortestRegularDistance = distanceToReservation;
				bestRegularDriver = driverMatch;
				logger.info(
					{ schedulingAlgorithm: "proximity", driverId, reservationId: reservation.id, options },
					`✅ Driver ${driverId} (Regular): NEW BEST REGULAR! Distance: ${distanceToReservation.toFixed(2)}km`
				);
			} else {
				logger.info(
					{ schedulingAlgorithm: "proximity", driverId, reservationId: reservation.id, options },
					`⏳ Driver ${driverId} (Regular): Eligible but not closest regular (distance: ${distanceToReservation.toFixed(
						2
					)}km, best: ${shortestRegularDistance.toFixed(2)}km)`
				);
			}
		} else if (isSecondaryDriver) {
			if (distanceToReservation < shortestSecondaryDistance) {
				shortestSecondaryDistance = distanceToReservation;
				bestSecondaryDriver = driverMatch;
				logger.info(
					{ schedulingAlgorithm: "proximity", driverId, reservationId: reservation.id, options },
					`✅ Driver ${driverId} (Secondary): NEW BEST SECONDARY! Distance: ${distanceToReservation.toFixed(
						2
					)}km`
				);
			} else {
				logger.info(
					{ schedulingAlgorithm: "proximity", driverId, reservationId: reservation.id, options },
					`⏳ Driver ${driverId} (Secondary): Eligible but not closest secondary (distance: ${distanceToReservation.toFixed(
						2
					)}km, best: ${shortestSecondaryDistance.toFixed(2)}km)`
				);
			}
		} else if (isReliefDriver) {
			if (distanceToReservation < shortestReliefDistance) {
				shortestReliefDistance = distanceToReservation;
				bestReliefDriver = driverMatch;
				logger.info(
					{ schedulingAlgorithm: "proximity", driverId, reservationId: reservation.id, options },
					`✅ Driver ${driverId} (Relief): NEW BEST RELIEF! Distance: ${distanceToReservation.toFixed(2)}km`
				);
			} else {
				logger.info(
					{ schedulingAlgorithm: "proximity", driverId, reservationId: reservation.id, options },
					`⏳ Driver ${driverId} (Relief): Eligible but not closest relief (distance: ${distanceToReservation.toFixed(
						2
					)}km, best: ${shortestReliefDistance.toFixed(2)}km)`
				);
			}
		}
	}

	// Select driver based on priority: Regular > Secondary > Relief
	if (bestRegularDriver) {
		bestDriver = bestRegularDriver;
		logger.info(
			{
				schedulingAlgorithm: "proximity",
				bestDriverId: bestDriver.driverId,
				reservationId: reservation.id,
				options,
			},
			`🎯 [PROXIMITY] SELECTED Regular Driver ${bestDriver.driverId} for reservation ${
				reservation.id
			} (distance: ${bestDriver.distanceToReservation.toFixed(2)}km)`
		);
	} else if (bestSecondaryDriver) {
		bestDriver = bestSecondaryDriver;
		logger.info(
			{
				schedulingAlgorithm: "proximity",
				bestDriverId: bestDriver.driverId,
				reservationId: reservation.id,
				options,
			},
			`🎯 [PROXIMITY] SELECTED Secondary Driver ${bestDriver.driverId} for reservation ${
				reservation.id
			} (distance: ${bestDriver.distanceToReservation.toFixed(2)}km) - No regular drivers available`
		);
	} else if (bestReliefDriver) {
		bestDriver = bestReliefDriver;
		logger.info(
			{
				schedulingAlgorithm: "proximity",
				bestDriverId: bestDriver.driverId,
				reservationId: reservation.id,
				options,
			},
			`🎯 [PROXIMITY] SELECTED Relief Driver ${bestDriver.driverId} for reservation ${
				reservation.id
			} (distance: ${bestDriver.distanceToReservation.toFixed(2)}km) - No regular or secondary drivers available`
		);
	} else {
		logger.info(
			{
				schedulingAlgorithm: "proximity",
				reservationId: reservation.id,
				bestDriverId: bestDriver?.driverId,
				options,
			},
			`❌ [PROXIMITY] NO DRIVER FOUND for reservation ${reservation.id}`
		);
	}

	return bestDriver;
}

/**
 * Assign a reservation to a driver and update their state
 */
function assignReservationToDriver(reservation, driverMatch, checkBatteryRange, options = {}) {
	const { driverId, driverState, transitTime, totalDistanceKm, updatedRangeKm, idleTime } = driverMatch;

	// Calculate estimated duration and end time
	const estimatedDurationSeconds = estimateReservationDuration(reservation);
	reservation.estimatedEndTime = reservation.internalReservationTime + estimatedDurationSeconds;
	reservation.estimatedEndTimeHumanReadable = momentTZ
		.unix(reservation.estimatedEndTime)
		.tz(TAIPEI_TIMEZONE)
		.format("YYYY-MM-DD HH:mm");

	// Analyze charging opportunity and add task if beneficial
	// 充電地點 = 前一趟行程終點；充電結束後需再開往下一趟起點，故充電 start 用 timeAtLastKnownLocation，結束後更新時間
	const { updatedRangeKm: analyzedRangeKm, shouldCreateTask } = analyzeChargingOpportunity(
		driverState.rangeKm,
		idleTime,
		checkBatteryRange,
		options
	);
	const finalUpdatedRangeKm = typeof analyzedRangeKm === "number" ? analyzedRangeKm : updatedRangeKm;

	if (shouldCreateTask) {
		// 充電 debug 資訊：僅供前端與除錯使用，不影響實際排程結果
		const arrivalTimeAtCharging = driverState.timeAtLastKnownLocation;
		const findStationSeconds =
			(options.estimatedTimeToFindChargingStationSeconds ??
				Env.estimatedTimeToFindChargingStationSeconds) || 0;
		const effectiveChargingSeconds = Math.max(0, idleTime - findStationSeconds);

		// 下一趟起點的移動時間，用於推算「最晚結束充電時間」（與 geo 模組 getPointToPointDurationBreakdown 一致）
		const transitDepartureTime = arrivalTimeAtCharging + idleTime; // 充電結束出發時間
		let transitToNextPickupSeconds = 0;
		let transitToNextPickupBreakdown = null;
		if (driverState.lastKnownLocation && reservation.origin && reservation.origin.geo) {
			transitToNextPickupSeconds = estimatePointToPointDuration(
				driverState.lastKnownLocation,
				reservation.origin.geo,
				transitDepartureTime
			);
			transitToNextPickupBreakdown = getPointToPointDurationBreakdown(
				driverState.lastKnownLocation,
				reservation.origin.geo,
				transitDepartureTime
			);
		}
		const mustFinishChargingTime =
			(reservation.internalReservationTime || reservation.reservationTime) -
			transitToNextPickupSeconds;
		const rangeGainKm = finalUpdatedRangeKm - driverState.rangeKm;

		const chargingTask = createChargingTask(
			idleTime,
			driverState.timeAtLastKnownLocation, // 充電在前趟終點開始，非抵達下一趟起點後
			driverState.rangeKm,
			finalUpdatedRangeKm,
			{
				arrivalTimeAtCharging,
				findStationSeconds,
				effectiveChargingSeconds,
				mustFinishChargingTime,
				idleTimeSeconds: idleTime,
				rangeGainKm,
				rangeCapKm: Env.defaultRangeKm,
				defaultRangeKm: Env.defaultRangeKm,
				transitToNextPickupSeconds,
				transitToNextPickupBreakdown,
				nextReservationTime: reservation.internalReservationTime || reservation.reservationTime,
			}
		);
		driverState.taskSequence.push(chargingTask);
		// 充電結束時間 = 開始 + 停留時長；駕駛之後還需 transitTime 趕往下一趟起點
		driverState.timeAtLastKnownLocation = driverState.timeAtLastKnownLocation + idleTime;
	}

	// Calculate remaining range after completing this reservation
	const remainingRangeAfterReservation = finalUpdatedRangeKm - totalDistanceKm;

	// Add reservation to driver's sequence
	driverState.reservationSequence.push(reservation);

	// Add reservation task to taskSequence
	const reservationDistanceKm = getDistance(reservation.origin.geo, reservation.dest.geo);
	const reservationTask = createReservationTask(reservation, reservationDistanceKm, remainingRangeAfterReservation);
	driverState.taskSequence.push(reservationTask);

	// Update driver state
	driverState.lastKnownLocation = reservation.dest.geo;
	driverState.lastKnownAddress = reservation.dest.address;
	driverState.timeAtLastKnownLocation = reservation.estimatedEndTime;
	driverState.rangeKm = remainingRangeAfterReservation;
}

/**
 * PROXIMITY SCHEDULING ALGORITHM - RESERVATION-CENTRIC GEOGRAPHICAL OPTIMIZATION
 * 
 * This function implements the newer proximity-based scheduling algorithm for the Zemo platform.
 * It uses a reservation-centric approach where each reservation is processed chronologically and
 * assigned to the closest available driver, optimizing for geographical efficiency over time-based assignment.
 * 
 * ALGORITHM CHARACTERISTICS:
 * - Reservation-centric: Processes one reservation at a time in chronological order
 * - Proximity-based assignment: Chooses the closest available driver for each reservation
 * - Dynamic state tracking: Updates driver location and availability after each assignment
 * - Geographical optimization: Minimizes total travel distance across the fleet
 * 
 * CORE WORKFLOW:
 * 1. Sort reservations by internal reservation time (accounting for buffer time)
 * 2. Initialize all drivers with their starting state (home location, available time, battery range)
 * 3. For each reservation in chronological order:
 *    - Find all eligible drivers who can reach the reservation on time
 *    - Select the closest available driver based on distance
 *    - Assign the reservation to that driver
 *    - Update the driver's location, time, and battery range
 * 4. Return formatted schedule with assignments and unassigned reservations
 * 
 * DRIVER ELIGIBILITY CRITERIA:
 * - Must be within their shift time window for the reservation
 * - Must be able to reach reservation origin in time (including transit and buffer time)
 * - Must have sufficient battery range for transit + reservation distance
 * - Must respect driver priority levels (Regular > Secondary > Relief)
 * 
 * PROXIMITY CALCULATION LOGIC:
 * - Distance measured from driver's current location to reservation origin
 * - Considers real-time driver state (location updated after each assignment)
 * - Factors in transit time, buffer time, and charging opportunities
 * - Maintains separate candidate pools by driver priority level
 * 
 * DRIVER PRIORITY SYSTEM:
 * - Regular drivers: First priority, closest regular driver selected first
 * - Secondary drivers: Second priority, only if no regular drivers available
 * - Relief drivers: Last priority, only if no regular or secondary drivers available
 * - Within each priority level, closest driver by distance is selected
 * 
 * PERFORMANCE CHARACTERISTICS:
 * - Time Complexity: O(reservations × drivers) with detailed distance calculations
 * - Space Complexity: O(drivers) for state tracking + O(reservations) for result
 * - Call Stack Depth: 5 levels (called from runSchedulingAlgorithm)
 * - Produces geographically optimized results with distance-based assignment
 * 
 * OPTIMIZATION FEATURES:
 * - Real-time battery range tracking with charging opportunity analysis
 * - Dynamic driver state updates (location, time, availability)
 * - Charging task insertion during idle periods between reservations
 * - Comprehensive logging for debugging and performance analysis
 * 
 * BUSINESS LOGIC INTEGRATION:
 * - Respects enterprise priority through driver classification system
 * - Handles battery range constraints for electric vehicle fleet
 * - Integrates with shift management and driver availability windows
 * - Supports both single-day and multi-day shift patterns
 * 
 * ALGORITHM STRENGTHS:
 * - Superior geographical efficiency and reduced total fleet travel distance
 * - Better resource utilization through optimal driver-reservation matching
 * - More flexible assignment that adapts to real-time driver positions
 * - Excellent for sparse, geographically distributed reservations
 * 
 * ALGORITHM LIMITATIONS:
 * - Higher computational cost due to distance calculations for all driver-reservation pairs
 * - May assign reservations to drivers with longer wait times if geographically optimal
 * - Potential for early reservations to "claim" drivers, leaving later gaps
 * 
 * ALGORITHM CHARACTERISTICS:
 * - Reservation-centric, distance-optimized, higher geographical efficiency
 * - Supports comprehensive features (battery range, charging, priority levels)
 * - Uses proximity-based scheduling for optimal geographical assignments
 */
function proximitySchedulingAlgorithm(reservationsInDay, driverHours, options = {}) {
	const startTime = Date.now();
	const { checkBatteryRange = false, enableEnhancedResponse = false } = options;
	
	if (reservationsInDay.length === 0) {
		const executionTime = Date.now() - startTime;
		logger.info({ schedulingAlgorithm: "proximity", options }, `\n📋 [PROXIMITY] No reservations to schedule`);
		const legacyResponse = {
			areCompatible: true,
			scheduleResult: {},
			unassignedReservations: [],
		};
		
		// Return enhanced response if requested
		if (enableEnhancedResponse) {
			return enhanceAlgorithmResponse(
				legacyResponse,
				"proximity",
				executionTime,
				driverHours,
				reservationsInDay,
				options
			);
		}
		
		return legacyResponse;
	}

	// Sort reservations by internal reservation time ascending
	for (const reservation of reservationsInDay) {
		populateInternalReservationTime(reservation);
	}
	const sortedReservations = _.cloneDeep(reservationsInDay).sort(
		(a, b) => a.internalReservationTime - b.internalReservationTime
	);

	const workDayStart = moment.unix(reservationsInDay[0].reservationTime).tz(TAIPEI_TIMEZONE).startOf("day");

	// Initialize driver states
	const driverStates = initializeDriverStates(driverHours, workDayStart);

	const unassignedReservations = [];

	// Process each reservation in chronological order
	logger.info(
		{ schedulingAlgorithm: "proximity", options, reservationIds: sortedReservations.map((r) => r.id).join(", ") },
		`\n🚀 [PROXIMITY] Starting scheduling for ${sortedReservations.length} reservations`
	);

	for (const reservation of sortedReservations) {
		logger.info(
			{ schedulingAlgorithm: "proximity", options },
			`\n📋 [PROXIMITY] Processing reservation ${reservation.id} at ${moment
				.unix(reservation.reservationTime)
				.tz(TAIPEI_TIMEZONE)
				.format("YYYY-MM-DD HH:mm")}`
		);

		const bestDriverMatch = findBestDriverForReservation(reservation, driverStates, options);

		if (bestDriverMatch) {
			// Assign reservation to the best (closest) available driver
			logger.info(
				{ schedulingAlgorithm: "proximity", options },
				`✅ [PROXIMITY] Assigning reservation ${reservation.id} to Driver ${bestDriverMatch.driverId}`
			);
			assignReservationToDriver(reservation, bestDriverMatch, checkBatteryRange, options);
		} else {
			// No available driver found
			logger.info(
				{ schedulingAlgorithm: "proximity", options },
				`❌ [PROXIMITY] No driver available for reservation ${reservation.id} - adding to unassigned`
			);
			unassignedReservations.push(reservation);
		}
	}

	// Format the schedule result to match expected output format
	// Merge split-shift entries (e.g., "286_0" and "286_1") back into a single driverId
	const formattedScheduleResult = {};
	for (const [stateKey, driverState] of Object.entries(driverStates)) {
		if (driverState.reservationSequence.length > 0 || driverState.taskSequence.length > 0) {
			const realId = String(driverState.driverId);
			if (!formattedScheduleResult[realId]) {
				formattedScheduleResult[realId] = { reservations: [], tasks: [] };
			}
			formattedScheduleResult[realId].reservations.push(...driverState.reservationSequence);
			formattedScheduleResult[realId].tasks.push(...driverState.taskSequence);
		}
	}
	// Sort merged results
	for (const entry of Object.values(formattedScheduleResult)) {
		entry.reservations.sort((a, b) => a.reservationTime - b.reservationTime);
		entry.tasks.sort((a, b) => a.startTime - b.startTime);
	}

	const executionTime = Date.now() - startTime;
	
	// Create home location lookup function
	const homeLocationLookupFn = createProximityHomeLocationLookup(driverStates);

	// Create standardized result with non-trip distances
	const legacyResponse = createScheduleResultWithNonTripDistances(
		formattedScheduleResult,
		unassignedReservations,
		homeLocationLookupFn,
		"proximity"
	);

	logger.info({ schedulingAlgorithm: "proximity", options }, `\n📊 [PROXIMITY] Scheduling complete:`);
	logger.info(
		{ schedulingAlgorithm: "proximity", options },
		`   ✅ Assigned: ${Object.keys(legacyResponse.scheduleResult).length} drivers`
	);
	logger.info(
		{ schedulingAlgorithm: "proximity", options },
		`   ❌ Unassigned: ${unassignedReservations.length} reservations`
	);
	logger.info(
		{ schedulingAlgorithm: "proximity", options },
		`   🎯 Success rate: ${(
			((sortedReservations.length - unassignedReservations.length) / sortedReservations.length) *
			100
		).toFixed(1)}%`
	);

	// Record metrics
	const algorithmType = options.algorithmType || "proximity";
	metrics.recordSchedulingAlgorithmDuration(algorithmType, executionTime / 1000); // Convert to seconds

	// Record vehicle assignment outcomes
	for (const [driverId, driverData] of Object.entries(formattedScheduleResult)) {
		for (const reservation of driverData.reservations) {
			const vehicleType = reservation.requiredVehicleType || reservation.vehicleType || "standard";
			metrics.recordVehicleAssignment(vehicleType, "assigned");
		}
	}

	for (const reservation of unassignedReservations) {
		const vehicleType = reservation.requiredVehicleType || reservation.vehicleType || "standard";
		metrics.recordVehicleAssignment(vehicleType, "rejected");
	}

	// Return enhanced response if requested
	if (enableEnhancedResponse) {
		return enhanceAlgorithmResponse(
			legacyResponse,
			"proximity",
			executionTime,
			driverHours,
			reservationsInDay,
			options
		);
	}
	
	return legacyResponse;
}

module.exports = { proximitySchedulingAlgorithm };
