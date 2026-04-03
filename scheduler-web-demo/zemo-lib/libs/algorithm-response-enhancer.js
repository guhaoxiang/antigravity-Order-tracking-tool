// No external dependencies needed

/**
 * ALGORITHM RESPONSE ENHANCER - PHASE 2.5.1 IMPLEMENTATION
 * 
 * This module provides utilities to transform legacy algorithm responses into the enhanced
 * Phase 2.5.1 response structure while maintaining backward compatibility.
 * 
 * Enhanced response structure provides:
 * - Clear algorithm identification and metadata
 * - Separated assignment results from performance metrics
 * - More intuitive field names
 * - Enhanced performance analytics
 * - Driver utilization metrics
 */

/**
 * Calculate driver utilization metrics for a single driver's schedule
 * @param {Object} driverSchedule - Driver's schedule with reservations and tasks
 * @param {number} shiftDurationSeconds - Total shift duration in seconds
 * @returns {Object} Utilization metrics
 */
function calculateDriverUtilization(driverSchedule, shiftDurationSeconds) {
	const { reservations = [], tasks = [] } = driverSchedule;
	
	// Calculate active time (time spent on reservations)
	const activeTime = reservations.reduce((total, reservation) => {
		const estimatedDuration = reservation.estimatedEndTime 
			? (reservation.estimatedEndTime - reservation.reservationTime)
			: 0;
		return total + estimatedDuration;
	}, 0);
	
	// Calculate idle time from charging tasks (approximate)
	const chargingTime = tasks
		.filter(task => task.type === 'charging')
		.reduce((total, task) => total + (task.duration || 0), 0);
	
	const totalWorkTime = Math.max(activeTime, shiftDurationSeconds);
	const idleTime = Math.max(0, totalWorkTime - activeTime);
	const utilizationRate = totalWorkTime > 0 ? (activeTime / totalWorkTime) * 100 : 0;
	
	return {
		totalWorkTime,
		activeTime,
		idleTime,
		utilizationRate: Math.round(utilizationRate * 100) / 100 // Round to 2 decimal places
	};
}

/**
 * Calculate fleet efficiency metrics from schedule result
 * @param {Object} scheduleResult - Complete schedule result
 * @param {Array} allDrivers - All available drivers (including unused ones)
 * @param {Array} allReservations - All reservations (including unassigned)
 * @returns {Object} Fleet efficiency metrics
 */
function calculateFleetEfficiency(scheduleResult, allDrivers, allReservations) {
	const totalDrivers = allDrivers.length;
	const activeDrivers = Object.keys(scheduleResult).length;
	const totalReservations = allReservations.length;
	const assignedReservations = Object.values(scheduleResult)
		.reduce((total, schedule) => total + (schedule.reservations?.length || 0), 0);
	
	const averageReservationsPerDriver = totalDrivers > 0 
		? totalReservations / totalDrivers 
		: 0;
	
	const fleetUtilizationRate = totalDrivers > 0 
		? (activeDrivers / totalDrivers) * 100 
		: 0;
	
	return {
		totalDrivers,
		activeDrivers,
		averageReservationsPerDriver: Math.round(averageReservationsPerDriver * 100) / 100,
		fleetUtilizationRate: Math.round(fleetUtilizationRate * 100) / 100
	};
}

/**
 * Calculate enhanced geographical performance metrics
 * @param {Object} legacyResponse - Legacy algorithm response
 * @returns {Object} Enhanced geographical metrics
 */
function calculateGeographicalPerformance(legacyResponse) {
	const {
		driverNonTripDistances = {},
		totalNonTripDistance = 0,
		driverHomeToFirstDistances = {}
	} = legacyResponse;
	
	// Calculate average non-trip distance
	const nonTripDistanceValues = Object.values(driverNonTripDistances).filter(d => d > 0);
	const averageNonTripDistance = nonTripDistanceValues.length > 0
		? nonTripDistanceValues.reduce((sum, d) => sum + d, 0) / nonTripDistanceValues.length
		: 0;
	
	// Calculate total home to first distance
	const homeToFirstDistanceValues = Object.values(driverHomeToFirstDistances).filter(d => d > 0);
	const totalHomeToFirstDistance = homeToFirstDistanceValues.reduce((sum, d) => sum + d, 0);
	
	return {
		driverNonTripDistances,
		totalNonTripDistance,
		averageNonTripDistance: Math.round(averageNonTripDistance * 100) / 100,
		driverHomeToFirstDistances,
		totalHomeToFirstDistance: Math.round(totalHomeToFirstDistance * 100) / 100
	};
}

/**
 * Transform legacy algorithm response into enhanced Phase 2.5.1 structure
 * @param {Object} legacyResponse - Original algorithm response
 * @param {string} algorithmName - Name of the algorithm ("proximity")
 * @param {number} executionTimeMs - Algorithm execution time in milliseconds
 * @param {Array} allDrivers - All available drivers
 * @param {Array} allReservations - All reservations
 * @param {Object} options - Additional options
 * @returns {Object} Enhanced response structure
 */
function enhanceAlgorithmResponse(legacyResponse, algorithmName, executionTimeMs, allDrivers, allReservations, options = {}) {
	const {
		areCompatible,
		scheduleResult = {},
		unassignedReservations = [],
		driverNonTripDistances = {},
		totalNonTripDistance = 0,
		driverHomeToFirstDistances = {}
	} = legacyResponse;
	
	// Calculate assignment metrics
	const totalReservations = allReservations.length;
	const assignedReservationsCount = totalReservations - unassignedReservations.length;
	const assignmentRate = totalReservations > 0 
		? (assignedReservationsCount / totalReservations) * 100 
		: 0;
	
	// Enhance schedule with driver utilization metrics
	const enhancedDrivers = {};
	for (const [driverId, driverSchedule] of Object.entries(scheduleResult)) {
		const driverInfo = allDrivers.find(d => d.driverId.toString() === driverId.toString());
		const shiftDurationSeconds = driverInfo 
			? (driverInfo.driverShiftEndUnix - driverInfo.driverShiftBeginUnix)
			: 8 * 60 * 60; // Default 8 hours if not found
		
		enhancedDrivers[driverId] = {
			reservations: driverSchedule.reservations || [],
			tasks: driverSchedule.tasks || [],
			utilization: calculateDriverUtilization(driverSchedule, shiftDurationSeconds)
		};
	}
	
	// Calculate performance metrics
	const geographical = calculateGeographicalPerformance(legacyResponse);
	const efficiency = calculateFleetEfficiency(scheduleResult, allDrivers, allReservations);
	
	// Build enhanced response structure
	const enhancedResponse = {
		algorithm: {
			name: algorithmName,
			version: "1.0",
			executionTimeMs: Math.round(executionTimeMs)
		},
		assignment: {
			successful: areCompatible,
			assignedReservations: assignedReservationsCount,
			unassignedReservations: unassignedReservations.length,
			assignmentRate: Math.round(assignmentRate * 100) / 100
		},
		schedule: {
			drivers: enhancedDrivers,
			unassignedReservations: unassignedReservations
		},
		performance: {
			geographical,
			efficiency
		},
		// Include legacy fields for backward compatibility (marked as deprecated)
		_legacy: {
			areCompatible,
			scheduleResult,
			unassignedReservations,
			driverNonTripDistances,
			totalNonTripDistance,
			driverHomeToFirstDistances
		}
	};
	
	return enhancedResponse;
}

/**
 * Create a backward compatibility transformer that extracts legacy format from enhanced response
 * @param {Object} enhancedResponse - Enhanced Phase 2.5.1 response
 * @returns {Object} Legacy response format
 */
function toLegacyFormat(enhancedResponse) {
	// Extract legacy fields if available, otherwise reconstruct from enhanced structure
	if (enhancedResponse._legacy) {
		return enhancedResponse._legacy;
	}
	
	// Reconstruct legacy format from enhanced structure
	return {
		areCompatible: enhancedResponse.assignment.successful,
		scheduleResult: Object.fromEntries(
			Object.entries(enhancedResponse.schedule.drivers).map(([driverId, driver]) => [
				driverId,
				{
					reservations: driver.reservations,
					tasks: driver.tasks
				}
			])
		),
		unassignedReservations: enhancedResponse.schedule.unassignedReservations,
		driverNonTripDistances: enhancedResponse.performance.geographical.driverNonTripDistances,
		totalNonTripDistance: enhancedResponse.performance.geographical.totalNonTripDistance,
		driverHomeToFirstDistances: enhancedResponse.performance.geographical.driverHomeToFirstDistances
	};
}

module.exports = {
	enhanceAlgorithmResponse,
	toLegacyFormat,
	calculateDriverUtilization,
	calculateFleetEfficiency,
	calculateGeographicalPerformance
};