const client = require("prom-client");

const registry = new client.Registry();

const geocodingApiUsageCounter = new client.Counter({
	name: "geocoding_api_usage_counter",
	help: "Count of calls made to the Google Geocoding API",
	labelNames: ["call_site"],
});
registry.registerMetric(geocodingApiUsageCounter);

function incrementGeocodingApiUsageCounter(callSite) {
	geocodingApiUsageCounter.labels(callSite).inc();
}

// ===== Scheduling Metrics =====

/**
 * Tracks reservation eligibility check outcomes
 * Labels:
 * - status: success | location_restricted | advance_booking_required | pricing_mismatch | other
 */
const reservationEligibilityChecksCounter = new client.Counter({
	name: "zemo_reservation_eligibility_checks_total",
	help: "Total number of reservation eligibility checks",
	labelNames: ["status"],
});
registry.registerMetric(reservationEligibilityChecksCounter);

/**
 * Tracks reservation accommodation check outcomes
 * Labels:
 * - status: assigned | waiting | rejected
 * - vehicle_type: standard | premium | accessible
 */
const reservationAccommodationChecksCounter = new client.Counter({
	name: "zemo_reservation_accommodation_checks_total",
	help: "Total number of reservation accommodation checks",
	labelNames: ["status", "vehicle_type"],
});
registry.registerMetric(reservationAccommodationChecksCounter);

/**
 * Tracks reservation creation outcomes
 * Labels:
 * - status: success | failure
 * - failure_reason: (when status=failure) scheduling_failed | validation_error | other
 */
const reservationCreationCounter = new client.Counter({
	name: "zemo_reservation_creation_total",
	help: "Total number of reservation creation attempts",
	labelNames: ["status", "failure_reason"],
});
registry.registerMetric(reservationCreationCounter);

/**
 * Tracks reservation modification outcomes
 * Labels:
 * - status: success | failure
 * - failure_reason: (when status=failure) scheduling_failed | validation_error | not_found | other
 */
const reservationModificationCounter = new client.Counter({
	name: "zemo_reservation_modification_total",
	help: "Total number of reservation modification attempts",
	labelNames: ["status", "failure_reason"],
});
registry.registerMetric(reservationModificationCounter);

/**
 * Tracks scheduling algorithm execution duration
 * Labels:
 * - algorithm_type: proximity | gap_filling | hybrid
 */
const schedulingAlgorithmDurationHistogram = new client.Histogram({
	name: "zemo_scheduling_algorithm_duration_seconds",
	help: "Duration of scheduling algorithm execution in seconds",
	labelNames: ["algorithm_type"],
	buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
});
registry.registerMetric(schedulingAlgorithmDurationHistogram);

/**
 * Tracks vehicle assignment outcomes
 * Labels:
 * - vehicle_type: standard | premium | accessible
 * - outcome: assigned | waitlisted | rejected
 */
const vehicleAssignmentOutcomesCounter = new client.Counter({
	name: "zemo_vehicle_assignment_outcomes_total",
	help: "Total number of vehicle assignment outcomes",
	labelNames: ["vehicle_type", "outcome"],
});
registry.registerMetric(vehicleAssignmentOutcomesCounter);

/**
 * Tracks vehicle capacity utilization ratio
 * Labels:
 * - vehicle_type: standard | premium | accessible
 * - time_slot: ISO timestamp truncated to hour
 */
const vehicleCapacityUtilizationGauge = new client.Gauge({
	name: "zemo_vehicle_capacity_utilization_ratio",
	help: "Current vehicle capacity utilization ratio (0-1)",
	labelNames: ["vehicle_type", "time_slot"],
});
registry.registerMetric(vehicleCapacityUtilizationGauge);

// Helper functions for scheduling metrics

function recordEligibilityCheck(status) {
	reservationEligibilityChecksCounter.labels(status).inc();
}

function recordAccommodationCheck(status, vehicleType) {
	reservationAccommodationChecksCounter.labels(status, vehicleType).inc();
}

function recordReservationCreation(status, failureReason = "") {
	reservationCreationCounter.labels(status, failureReason).inc();
}

function recordReservationModification(status, failureReason = "") {
	reservationModificationCounter.labels(status, failureReason).inc();
}

function recordSchedulingAlgorithmDuration(algorithmType, durationSeconds) {
	schedulingAlgorithmDurationHistogram.labels(algorithmType).observe(durationSeconds);
}

function recordVehicleAssignment(vehicleType, outcome) {
	vehicleAssignmentOutcomesCounter.labels(vehicleType, outcome).inc();
}

function setVehicleCapacityUtilization(vehicleType, timeSlot, utilizationRatio) {
	vehicleCapacityUtilizationGauge.labels(vehicleType, timeSlot).set(utilizationRatio);
}

module.exports = {
	incrementGeocodingApiUsageCounter,
	// Scheduling metrics
	recordEligibilityCheck,
	recordAccommodationCheck,
	recordReservationCreation,
	recordReservationModification,
	recordSchedulingAlgorithmDuration,
	recordVehicleAssignment,
	setVehicleCapacityUtilization,
};
