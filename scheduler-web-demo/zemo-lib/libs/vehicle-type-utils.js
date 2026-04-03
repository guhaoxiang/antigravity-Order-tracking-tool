const _ = require("lodash");
const { createLogger } = require("./logging");

const logger = createLogger("vehicle-type-utils");

/**
 * Vehicle type constants
 */
const VEHICLE_TYPES = {
	STANDARD: "STANDARD",
	LARGE: "LARGE",
};

// Note: Capacity-based vehicle type determination removed per requirement
// Going forward, only explicit requiredVehicleType field is used

/**
 * Check if a driver's vehicle type can handle a reservation's requirements
 * @param {string} driverVehicleType - Driver's vehicle type ('STANDARD' or 'LARGE')
 * @param {string|null} requiredVehicleType - Required vehicle type or null for any
 * @returns {boolean} True if driver can handle the reservation
 */
function isVehicleTypeCompatible(driverVehicleType, requiredVehicleType) {
	// If no specific vehicle type is required, any driver can handle it
	if (requiredVehicleType === null || requiredVehicleType === undefined) {
		return true;
	}

	// If large vehicle is required, only large vehicle drivers can handle it
	if (requiredVehicleType === VEHICLE_TYPES.LARGE) {
		return driverVehicleType === VEHICLE_TYPES.LARGE;
	}

	// For standard vehicle requirements, any driver can handle it
	// (this case shouldn't normally occur since we use null for flexible requirements)
	return true;
}

/**
 * Partition drivers by their vehicle type
 * @param {Array} driverHours - Array of driver shift objects with vehicleType
 * @returns {Object} Object with largeVehicleDrivers and standardVehicleDrivers arrays
 */
function partitionDriversByVehicleType(driverHours) {
	const largeVehicleDrivers = [];
	const standardVehicleDrivers = [];

	for (const driverHour of driverHours) {
		const vehicleType = driverHour.vehicleType || VEHICLE_TYPES.STANDARD;
		
		if (vehicleType === VEHICLE_TYPES.LARGE) {
			largeVehicleDrivers.push(driverHour);
		} else {
			standardVehicleDrivers.push(driverHour);
		}
	}

	logger.info(
		{
			totalDrivers: driverHours.length,
			largeVehicleDrivers: largeVehicleDrivers.length,
			standardVehicleDrivers: standardVehicleDrivers.length,
		},
		"[partitionDriversByVehicleType] Driver partitioning complete"
	);

	return {
		largeVehicleDrivers,
		standardVehicleDrivers,
	};
}

/**
 * Classify reservations by their vehicle type requirements
 * @param {Array} reservations - Array of reservation objects
 * @returns {Object} Object with largeRequiredReservations and anyTypeReservations arrays
 */
function classifyReservationsByVehicleType(reservations) {
	const largeRequiredReservations = [];
	const anyTypeReservations = [];

	for (const reservation of reservations) {
		// Only check explicit requiredVehicleType field (no capacity-based determination)
		const requiredType = reservation.requiredVehicleType;

		if (requiredType === VEHICLE_TYPES.LARGE) {
			largeRequiredReservations.push(reservation);
		} else {
			anyTypeReservations.push(reservation);
		}
	}

	logger.info(
		{
			totalReservations: reservations.length,
			largeRequiredReservations: largeRequiredReservations.length,
			anyTypeReservations: anyTypeReservations.length,
		},
		"[classifyReservationsByVehicleType] Reservation classification complete"
	);

	return {
		largeRequiredReservations,
		anyTypeReservations,
	};
}

/**
 * Filter reservations that can be handled by standard vehicle drivers
 * @param {Array} reservations - Array of reservation objects
 * @returns {Array} Reservations that standard vehicles can handle
 */
function filterStandardCompatibleReservations(reservations) {
	return reservations.filter((reservation) => {
		// Only check explicit requiredVehicleType field (no capacity-based determination)
		const requiredType = reservation.requiredVehicleType;
		
		// If large vehicle is required, standard vehicles cannot handle it
		return requiredType !== VEHICLE_TYPES.LARGE;
	});
}

/**
 * Check if vehicle type routing is needed based on drivers and reservations
 * @param {Array} driverHours - Array of driver shift objects
 * @param {Array} reservations - Array of reservation objects
 * @returns {boolean} True if vehicle routing is needed
 */
function isVehicleTypeRoutingNeeded(driverHours, reservations) {
	// Check if we have any large vehicle drivers
	const hasLargeVehicleDrivers = driverHours.some((driver) => {
		const vehicleType = driver.vehicleType || VEHICLE_TYPES.STANDARD;
		return vehicleType === VEHICLE_TYPES.LARGE;
	});

	// Check if we have any reservations requiring large vehicles
	const hasLargeVehicleReservations = reservations.some((reservation) => {
		// Only check explicit requiredVehicleType field (no capacity-based determination)
		return reservation.requiredVehicleType === VEHICLE_TYPES.LARGE;
	});

	const routingNeeded = hasLargeVehicleDrivers || hasLargeVehicleReservations;
	
	logger.info(
		{
			hasLargeVehicleDrivers,
			hasLargeVehicleReservations,
			routingNeeded,
		},
		"[isVehicleTypeRoutingNeeded] Vehicle type routing assessment"
	);

	return routingNeeded;
}

module.exports = {
	VEHICLE_TYPES,
	isVehicleTypeCompatible,
	partitionDriversByVehicleType,
	classifyReservationsByVehicleType,
	filterStandardCompatibleReservations,
	isVehicleTypeRoutingNeeded,
};