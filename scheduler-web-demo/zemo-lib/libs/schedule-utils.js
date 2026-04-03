const { calculateNonTripDistance, getDistance } = require("./geo");
const { createLogger } = require("./logging");
const Env = require("./environment");

// Re-export charging utilities for backward compatibility
const {
	analyzeChargingOpportunity,
	createChargingTask,
	createReservationTask,
	analyzeScheduleFeasibility,
} = require("./charging");

const logger = createLogger("schedule-utils");

/**
 * Calculate non-trip distances for all drivers in a schedule result
 * @param {Object} scheduleResult - The schedule result object containing driver schedules
 * @param {Function} homeLocationLookupFn - Function to get home location for a driver ID
 * @returns {Object} Object containing driverNonTripDistances and totalNonTripDistance
 */
function calculateScheduleNonTripDistances(scheduleResult, homeLocationLookupFn) {
	const driverNonTripDistances = {};
	let totalNonTripDistance = 0;

	logger.debug(
		{
			scheduledDriverIds: Object.keys(scheduleResult),
			scheduledDriverCount: Object.keys(scheduleResult).length,
			driversWithReservations: Object.entries(scheduleResult)
				.filter(([id, schedule]) => schedule.reservations?.length > 0)
				.map(([id]) => id),
		},
		"Starting non-trip distance calculation for all scheduled drivers"
	);

	for (const [driverId, driverSchedule] of Object.entries(scheduleResult)) {
		const homeLocation = homeLocationLookupFn(driverId);

		logger.debug(
			{
				driverId,
				driverIdType: typeof driverId,
				hasReservations: (driverSchedule.reservations?.length || 0) > 0,
				reservationCount: driverSchedule.reservations?.length || 0,
				homeLocationFound: !!homeLocation,
				homeLocationDetails: homeLocation
					? {
							hasGeo: !!homeLocation.geo,
							hasAddress: !!homeLocation.address,
							address: homeLocation.address,
					  }
					: null,
			},
			"Processing driver for non-trip distance calculation"
		);

		if (homeLocation) {
			const nonTripDistance = calculateNonTripDistance(driverSchedule, homeLocation);
			driverNonTripDistances[driverId] = nonTripDistance;
			totalNonTripDistance += nonTripDistance;

			// Debug logging for successful calculations
			if (nonTripDistance > 0) {
				logger.debug(
					{
						driverId,
						nonTripDistance: nonTripDistance.toFixed(2),
						reservationCount: driverSchedule.reservations?.length || 0,
						homeAddress: homeLocation.address,
					},
					"Non-trip distance calculated successfully"
				);
			}
		} else {
			driverNonTripDistances[driverId] = 0;

			// Debug logging for missing home locations
			logger.warn(
				{
					driverId,
					driverIdType: typeof driverId,
					hasReservations: (driverSchedule.reservations?.length || 0) > 0,
				},
				"Home location not found for driver - setting non-trip distance to 0"
			);
		}
	}

	return {
		driverNonTripDistances,
		totalNonTripDistance,
	};
}

/**
 * Calculate home to first trip distances for all drivers in a schedule result
 * @param {Object} scheduleResult - The schedule result object containing driver schedules
 * @param {Function} homeLocationLookupFn - Function to get home location for a driver ID
 * @returns {Object} Object containing driverHomeToFirstDistances
 */
function calculateHomeToFirstDistances(scheduleResult, homeLocationLookupFn) {
	const driverHomeToFirstDistances = {};

	logger.debug(
		{
			scheduledDriverIds: Object.keys(scheduleResult),
			scheduledDriverCount: Object.keys(scheduleResult).length,
		},
		"Starting home to first trip distance calculation for all scheduled drivers"
	);

	for (const [driverId, driverSchedule] of Object.entries(scheduleResult)) {
		let homeToFirstDistance = 0;

		try {
			// Get home location for this driver
			const homeLocation = homeLocationLookupFn(driverId);

			if (
				homeLocation &&
				homeLocation.geo &&
				driverSchedule.reservations &&
				driverSchedule.reservations.length > 0
			) {
				// Sort reservations by time to get the first one
				const sortedReservations = [...driverSchedule.reservations].sort(
					(a, b) => a.reservationTime - b.reservationTime
				);
				const firstReservation = sortedReservations[0];

				if (firstReservation && firstReservation.origin && firstReservation.origin.geo) {
					homeToFirstDistance = getDistance(homeLocation.geo, firstReservation.origin.geo);
				}
			}
		} catch (error) {
			logger.error(
				{ driverId, error: error.message },
				"Error calculating home to first trip distance for driver"
			);
		}

		driverHomeToFirstDistances[driverId] = homeToFirstDistance;

		logger.debug(
			{ driverId, homeToFirstDistance: homeToFirstDistance.toFixed(2) },
			"Calculated home to first trip distance for driver"
		);
	}

	return { driverHomeToFirstDistances };
}

/**
 * Create a home location lookup function for scheduling algorithms
 * @param {Array} sortedHours - Array of driver hours with home locations
 * @returns {Function} Function that looks up home location by driver ID
 */
function createHomeLocationLookup(sortedHours) {
	// Debug: Log the structure of sortedHours
	const driverIdCounts = {};
	sortedHours.forEach((h) => {
		driverIdCounts[h.driverId] = (driverIdCounts[h.driverId] || 0) + 1;
	});

	// Log first few complete driver records to see actual structure
	const firstFewDrivers = sortedHours.slice(0, 5).map((h) => ({
		driverId: h.driverId,
		driverIdType: typeof h.driverId,
		homeLocation: h.homeLocation, // Full home location object
		allDriverFields: Object.keys(h), // All available fields
		shiftInfo: h.shift
			? {
					shiftBeginTime: h.shift.shiftBeginTime,
					shiftEndTime: h.shift.shiftEndTime,
			  }
			: null,
	}));

	// Log all drivers with complete data structure for diagnosis
	const allDriversDebugInfo = sortedHours.map((h, index) => ({
		index,
		driverId: h.driverId,
		driverIdType: typeof h.driverId,
		allFields: Object.keys(h),
		hasHomeLocationProperty: h.hasOwnProperty("homeLocation"),
		homeLocationValue: h.homeLocation,
		homeLocationType: typeof h.homeLocation,
		homeLocationTruthy: !!h.homeLocation,
	}));

	logger.info(
		{
			totalDrivers: sortedHours.length,
			uniqueDrivers: Object.keys(driverIdCounts).length,
			duplicateDrivers: Object.entries(driverIdCounts).filter(([id, count]) => count > 1),
			driversWithHomeLocation: allDriversDebugInfo.filter((d) => d.homeLocationTruthy).length,
			driversWithNullHomeLocation: allDriversDebugInfo.filter(
				(d) => d.hasHomeLocationProperty && !d.homeLocationTruthy
			).length,
			driversWithMissingHomeLocation: allDriversDebugInfo.filter((d) => !d.hasHomeLocationProperty).length,
			firstFewCompleteDriverRecords: firstFewDrivers,
			allDriversDebugInfo: allDriversDebugInfo,
		},
		"🔍 COMPLETE DRIVER DATA STRUCTURE ANALYSIS"
	);

	return function (driverId) {
		logger.debug(
			{
				lookupDriverId: driverId,
				lookupDriverIdType: typeof driverId,
				totalAvailableDrivers: sortedHours.length,
			},
			"Home location lookup called"
		);

		const driverHour = sortedHours.find((hour) => hour.driverId.toString() === driverId.toString());

		if (!driverHour) {
			logger.debug(
				{
					driverId,
					lookupDriverIdType: typeof driverId,
					availableDriverIds: sortedHours.map((h) => h.driverId),
					availableDriverIdTypes: sortedHours.map((h) => typeof h.driverId),
				},
				"Driver not found in sortedHours"
			);
		} else if (!driverHour.homeLocation) {
			logger.debug(
				{
					driverId,
					driverHourKeys: Object.keys(driverHour),
					homeLocationValue: driverHour.homeLocation,
				},
				"Driver found but homeLocation is missing or null"
			);
		} else {
			logger.debug(
				{
					driverId,
					homeLocationFound: true,
					homeAddress: driverHour.homeLocation?.address,
				},
				"Driver found with valid home location"
			);
		}

		return driverHour?.homeLocation || null;
	};
}

/**
 * Create a home location lookup function for proximity algorithm
 * @param {Object} driverStates - Object containing driver states with home locations
 * @returns {Function} Function that looks up home location by driver ID
 */
function createProximityHomeLocationLookup(driverStates) {
	// Debug: Log the structure of driverStates
	const driverIds = Object.keys(driverStates);
	logger.debug(
		{
			totalDriverStates: driverIds.length,
			sampleDriverIds: driverIds.slice(0, 3),
			sampleHasHomeLocation: driverIds.slice(0, 3).map((id) => !!driverStates[id]?.homeLocation),
		},
		"Creating proximity home location lookup"
	);

	return function (driverId) {
		const driverState = driverStates[driverId];

		if (!driverState) {
			logger.debug({ driverId, availableDriverIds: Object.keys(driverStates) }, "Driver state not found");
		} else if (!driverState.homeLocation) {
			logger.debug(
				{ driverId, driverStateKeys: Object.keys(driverState) },
				"Driver state found but homeLocation is missing"
			);
		}

		return driverState?.homeLocation || null;
	};
}

/**
 * Remove unnecessary charging tasks after the last reservation for each driver
 * @param {Object} scheduleResult - The schedule result object
 * @returns {Object} Updated schedule result with unnecessary charging tasks removed
 */
function removeUnnecessaryChargingTasksAfterLastReservation(scheduleResult) {
	for (const [driverId, schedule] of Object.entries(scheduleResult)) {
		if (schedule.reservations.length === 0) {
			// No reservations, so no need to keep any charging tasks
			schedule.tasks = schedule.tasks.filter((task) => task.type !== "charging");
			continue;
		}

		// Find the end time of the last reservation
		const lastReservation = schedule.reservations[schedule.reservations.length - 1];
		const lastReservationEndTime = lastReservation.estimatedEndTime;

		// Remove charging tasks that start after the last reservation ends
		schedule.tasks = schedule.tasks.filter((task) => {
			if (task.type === "charging") {
				return task.startTime < lastReservationEndTime;
			}
			return true;
		});
	}
	return scheduleResult;
}

/**
 * Create a standardized schedule result with non-trip distances
 * @param {Object} scheduleResult - The formatted schedule result
 * @param {Array} unassignedReservations - Array of unassigned reservations
 * @param {Function} homeLocationLookupFn - Function to get home location for a driver ID
 * @param {string} algorithmName - Name of the scheduling algorithm for logging
 * @returns {Object} Complete schedule result with non-trip distances and home to first distances
 */
function createScheduleResultWithNonTripDistances(
	scheduleResult,
	unassignedReservations,
	homeLocationLookupFn,
	algorithmName
) {
	// Remove unnecessary charging tasks after the last reservation
	const finalScheduleResult = removeUnnecessaryChargingTasksAfterLastReservation(scheduleResult);

	// Calculate non-trip distances for each driver
	const { driverNonTripDistances, totalNonTripDistance } = calculateScheduleNonTripDistances(
		finalScheduleResult,
		homeLocationLookupFn
	);

	// Calculate home to first trip distances for each driver
	const { driverHomeToFirstDistances } = calculateHomeToFirstDistances(finalScheduleResult, homeLocationLookupFn);

	// Log the total non-trip distance
	logger.info(
		{ schedulingAlgorithm: algorithmName },
		`🚗 [${algorithmName.toUpperCase()}] Total non-trip distance: ${totalNonTripDistance.toFixed(2)} km`
	);

	return {
		areCompatible: unassignedReservations.length === 0,
		scheduleResult: finalScheduleResult,
		unassignedReservations: unassignedReservations,
		driverNonTripDistances: driverNonTripDistances,
		totalNonTripDistance: totalNonTripDistance,
		driverHomeToFirstDistances: driverHomeToFirstDistances, // Add home to first distances
	};
}

module.exports = {
	calculateScheduleNonTripDistances,
	calculateHomeToFirstDistances,
	createHomeLocationLookup,
	createProximityHomeLocationLookup,
	removeUnnecessaryChargingTasksAfterLastReservation,
	createScheduleResultWithNonTripDistances,
	analyzeChargingOpportunity,
	createChargingTask,
	createReservationTask,
	analyzeScheduleFeasibility,
};
