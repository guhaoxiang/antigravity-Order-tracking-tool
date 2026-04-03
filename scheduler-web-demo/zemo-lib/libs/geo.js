const _ = require("lodash");
const Distance = require("geo-distance");
const turfHelpers = require("@turf/helpers");
const pointsWithinPolygon = require("@turf/points-within-polygon");
const moment = require("moment");
const momentTZ = require("moment-timezone");

const { ENUM_REGION, ENUM_DISTANCE_EXTRA, ENUM_RESERVATION_LOCATION_TYPE, ENUM_AIRPORT_CODE } = require("../libs/enum");
const Env = require("./environment");
const { TAIPEI_TIMEZONE } = require("../constants/constants");

const { createLogger } = require("./logging");
const logger = createLogger("libs/geo");

function sanitizeLocation(location) {
	const lat = location.lat || location.latitude;
	const lng = location.lng || location.lon || location.longitude;
	return {
		latitude: lat,
		longitude: lng,
		lat,
		lng,
		lon: lng,
	};
}

// The unit of the return value is km.
function getDistance(a, b) {
	// build the objects that can be fed into geo-distance
	const ori = { lat: a.lat, lon: a.lng };
	const dst = { lat: b.lat, lon: b.lng };
	const dist = Distance.between(ori, dst).human_readable();
	// check if the unit is m (instead of km)
	if (dist.unit == "m") return parseFloat(Distance.between(ori, dst).human_readable().distance) / 1000;
	return parseFloat(Distance.between(ori, dst).human_readable().distance);
}

function hasArrivedAtLocation(vehicleLocation, targetLocation) {
	const sanitizedTargetLocation = sanitizeLocation(targetLocation);
	const sanitizedVehicleLocation = sanitizeLocation(vehicleLocation);
	if (
		isAtTpeAirport(sanitizedTargetLocation.latitude, sanitizedTargetLocation.longitude) &&
		isAtTpeAirport(sanitizedVehicleLocation.latitude, sanitizedVehicleLocation.longitude)
	) {
		return true;
	} else if (
		isAtTsaAirport(sanitizedTargetLocation.latitude, sanitizedTargetLocation.longitude) &&
		isAtTsaAirport(sanitizedVehicleLocation.latitude, sanitizedVehicleLocation.longitude)
	) {
		return true;
	} else if (
		getDistance(
			{ lat: sanitizedTargetLocation.latitude, lng: sanitizedTargetLocation.longitude },
			{ lat: sanitizedVehicleLocation.latitude, lng: sanitizedVehicleLocation.longitude }
		) <= 0.1
	) {
		return true;
	}
	return false;
}

function getRegionFactorAdditionalMinutes(location, isRushHour, isHoliday) {
	if (isHoliday) {
		if (isInTamshuiRegion(location.lat, location.lng)) {
			return 40.0;
		}
		if (isInYilanRegion(location.lat, location.lng)) {
			return 90.0;
		}
	} else if (isRushHour) {
		if (isInTamshuiRegion(location.lat, location.lng)) {
			return 30.0;
		}
		if (isInNangangNeihuRegion(location.lat, location.lng)) {
			return 10.0;
		}
		if (isInXinzhuangRegion(location.lat, location.lng)) {
			return 5.0;
		}
		if (isInLinkouPlateauRegion(location.lat, location.lng)) {
			return 10.0;
		}
		if (isInYilanRegion(location.lat, location.lng)) {
			return 20.0;
		}
	} else {
		if (isInTamshuiRegion(location.lat, location.lng)) {
			return 10.0;
		}
		if (isInYilanRegion(location.lat, location.lng)) {
			return 20.0;
		}
	}
	return 0.0;
}

function getHourFactorAdditionalMinutes(referenceTime) {
	if (isHolidayStartTime(referenceTime)) {
		return Env.geoLightHourMinutes;
	}

	if (isLightHourStartTime(referenceTime)) {
		return Env.geoLightHourMinutes;
	} else if (isRushHourStartTime(referenceTime)) {
		return Env.geoRushHourMinutes;
	} else {
		return 0.0;
	}
}

function getEstimatedSpeedKmhFromBands(dist) {
	const bands = Env.geoEstimatedSpeedBands;
	for (let i = 0; i < bands.length; i++) {
		if (dist <= bands[i].maxDist) return bands[i].speed;
	}
	return bands[bands.length - 1] ? bands[bands.length - 1].speed : 62;
}

function getRawTimeEstimate(from, to) {
	const dist = getDistance(from, to);
	const estimatedSpeedKmh = getEstimatedSpeedKmhFromBands(dist);
	return (3600 * dist) / estimatedSpeedKmh;
}

// The unit of the return value is seconds.
function estTime(from, to, referenceTime) {
	const isRushHour = isRushHourStartTime(referenceTime);
	const isHoliday = isHolidayStartTime(referenceTime);
	return (
		getRawTimeEstimate(from, to) +
		getRegionFactorAdditionalMinutes(from, isRushHour, isHoliday) * 60 +
		getRegionFactorAdditionalMinutes(to, isRushHour, isHoliday) * 60 +
		getHourFactorAdditionalMinutes(referenceTime) * 60
	);
}

/**
 * 回傳點對點行駛時間拆解：基礎時間（僅距離/時速）與額外消耗（尖峰/區域加成）
 * @param {{ lat, lng }} from
 * @param {{ lat, lng }} to
 * @param {number} referenceTime - Unix timestamp
 * @returns {{ totalSec: number, baseSec: number, extraSec: number, extraReason: string, hourFactorMinutes: number, regionMinutes: number, distanceKm: number, estimatedSpeedKmh: number }}
 */
function getPointToPointDurationBreakdown(from, to, referenceTime) {
	const dist = getDistance(from, to);
	const estimatedSpeedKmh = getEstimatedSpeedKmhFromBands(dist);
	const baseSec = (3600 * dist) / estimatedSpeedKmh;
	const isRushHour = isRushHourStartTime(referenceTime);
	const isHoliday = isHolidayStartTime(referenceTime);
	const regionFromMin = getRegionFactorAdditionalMinutes(from, isRushHour, isHoliday);
	const regionToMin = getRegionFactorAdditionalMinutes(to, isRushHour, isHoliday);
	const regionMinutes = regionFromMin + regionToMin;
	const hourFactorMinutes = getHourFactorAdditionalMinutes(referenceTime);
	const regionFrom = regionFromMin * 60;
	const regionTo = regionToMin * 60;
	const hourFactor = hourFactorMinutes * 60;
	const extraSec = regionFrom + regionTo + hourFactor;
	const parts = [];
	if (hourFactor !== 0) parts.push(hourFactor > 0 ? "尖峰時段加成" : "離峰時段加成");
	if (regionFrom !== 0 || regionTo !== 0) parts.push("區域加成");
	const extraReason = parts.length ? parts.join("、") : "無";
	return {
		totalSec: baseSec + extraSec,
		baseSec,
		extraSec,
		extraReason,
		hourFactorMinutes,
		regionMinutes,
		distanceKm: dist,
		estimatedSpeedKmh,
	};
}

function estAirportTransitTime(dist, isLightHour) {
	if (isLightHour) {
		return (3600 * dist) / Env.estimatedLightHourAirportSpeedKmh;
	} else {
		return (3600 * dist) / Env.estimatedAirportSpeedKmh;
	}
}

// from = { lat, lng }
// to = { lat, lng }
function estimatePointToPointDuration(from, to, referenceTime) {
	return estTime(from, to, referenceTime);
}

function isLightHourStartTime(startTime) {
	const dayStartTime = momentTZ.unix(startTime).tz(TAIPEI_TIMEZONE).startOf("d");
	const earlyMorningCutOff = _.cloneDeep(dayStartTime).add(Env.geoLightHourEarlyEndMin, "m");
	const lateNightCutOff = _.cloneDeep(dayStartTime).add(Env.geoLightHourLateStartMin, "m");
	const reservationMoment = momentTZ.unix(startTime);
	if (reservationMoment.isSameOrBefore(earlyMorningCutOff) || reservationMoment.isSameOrAfter(lateNightCutOff)) {
		return true;
	} else {
		return false;
	}
}

function isRushHourStartTime(startTime) {
	const dayStartTime = momentTZ.unix(startTime).tz(TAIPEI_TIMEZONE).startOf("d");
	const morningRushHourStart = _.cloneDeep(dayStartTime).add(Env.geoRushHourMorningStartMin, "m");
	const morningRushHourEnd = _.cloneDeep(dayStartTime).add(Env.geoRushHourMorningEndMin, "m");
	const eveningRushHourStart = _.cloneDeep(dayStartTime).add(Env.geoRushHourEveningStartMin, "m");
	const eveningRushHourEnd = _.cloneDeep(dayStartTime).add(Env.geoRushHourEveningEndMin, "m");
	const reservationMoment = momentTZ.unix(startTime);
	if (
		(reservationMoment.isSameOrAfter(morningRushHourStart) && reservationMoment.isBefore(morningRushHourEnd)) ||
		(reservationMoment.isSameOrAfter(eveningRushHourStart) && reservationMoment.isBefore(eveningRushHourEnd))
	) {
		return true;
	} else {
		return false;
	}
}

function isHolidayStartTime(startTime) {
	const dayStartTime = momentTZ.unix(startTime).tz(TAIPEI_TIMEZONE).startOf("d");
	const reservationMoment = momentTZ.unix(startTime).tz(TAIPEI_TIMEZONE);

	const eveningHolidyEnd = _.cloneDeep(dayStartTime).add(20, "h");
	const before8pm = reservationMoment.isSameOrBefore(eveningHolidyEnd);

	const dayOfWeek = reservationMoment.day(); // 0 is Sunday, 6 is Saturday
	// Check if it's Saturday (6) or Sunday (0)
	return before8pm && (dayOfWeek === 0 || dayOfWeek === 6);
}

// 50 minutes of flight delay and baggage claim buffer for passenger arriving into the airport.
const AIRPORT_ARRIVAL_WAIT_TIME = 60 * 50;
function estimateReservationDuration(res) {
	let padding = 0;
	if (isAtTpeAirport(res.origin.geo.lat, res.origin.geo.lng)) {
		// Pad some buffer for waiting passenger arriving at the airport in case of flight delay.
		padding = AIRPORT_ARRIVAL_WAIT_TIME;
	}

	if (res.moreStops == null || res.moreStops.length == 0) {
		return estimatePointToPointDuration(res.origin.geo, res.dest.geo, res.reservationTime) + padding;
	}

	// Calculate total duration following the sequential route:
	// Origin → Stop1 → Stop2 → ... → StopN → Destination
	let total = 0;

	// Duration from origin to first stop
	total += estimatePointToPointDuration(res.origin.geo, res.moreStops[0].geo, res.reservationTime);

	// Duration between consecutive stops
	for (let i = 1; i < res.moreStops.length; i++) {
		total += estimatePointToPointDuration(res.moreStops[i - 1].geo, res.moreStops[i].geo, res.reservationTime);
	}

	// Duration from last stop to destination
	total += estimatePointToPointDuration(
		res.moreStops[res.moreStops.length - 1].geo,
		res.dest.geo,
		res.reservationTime
	);
	if (res.hasOwnProperty("moreStops")) {
		padding += Env.estimatedDelaySeconds * (res.moreStops.length + 1);
	}
	return total + padding;
}

function getReservationDistance(res) {
	try {
		if (res.moreStops == null || res.moreStops.length == 0) {
			return getDistance(res.dest.geo, res.origin.geo);
		}

		// Calculate total distance following the sequential route:
		// Origin → Stop1 → Stop2 → ... → StopN → Destination
		let total = 0;

		// Distance from origin to first stop
		total += getDistance(res.origin.geo, res.moreStops[0].geo);

		// Distance between consecutive stops
		for (let i = 1; i < res.moreStops.length; i++) {
			total += getDistance(res.moreStops[i - 1].geo, res.moreStops[i].geo);
		}

		// Distance from last stop to destination
		total += getDistance(res.moreStops[res.moreStops.length - 1].geo, res.dest.geo);

		return total;
	} catch (error) {
		logger.error(
			{ error, reservationId: res.id, reservationTime: res.reservationTime, origin: res.origin, dest: res.dest },
			"[getReservationDistance] exception"
		);
	}
}

// Compare two latlng (geo) objects up to the accuracy of 4 decimal places, which translates to 11 meters.
function areEqualLatLng(a, b) {
	const latA = parseFloat(a.lat).toFixed(4);
	const lngA = parseFloat(a.lng).toFixed(4);
	const latB = parseFloat(b.lat).toFixed(4);
	const lngB = parseFloat(b.lng).toFixed(4);

	return latA === latB && lngA === lngB;
}

/**
 * Calculate total non-trip distance for a driver's schedule
 * @param {Object} driverSchedule - The driver's schedule containing reservations and home location
 * @param {Object} homeLocation - Driver's home location {geo: {lat, lng}, address}
 * @returns {number} Total non-trip distance in kilometers
 */
function calculateNonTripDistance(driverSchedule, homeLocation) {
	const reservations = driverSchedule.reservations || [];

	if (reservations.length === 0) {
		return 0;
	}

	// Sort reservations by time to ensure correct sequence
	const sortedReservations = [...reservations].sort((a, b) => a.reservationTime - b.reservationTime);

	let totalNonTripDistance = 0;

	// Distance from home to first reservation origin
	const firstReservation = sortedReservations[0];
	totalNonTripDistance += getDistance(homeLocation.geo, firstReservation.origin.geo);

	// Distance between subsequent trips (destination of previous to origin of next)
	for (let i = 1; i < sortedReservations.length; i++) {
		const previousReservation = sortedReservations[i - 1];
		const currentReservation = sortedReservations[i];

		// Handle reservations with multiple stops
		let previousEndLocation;
		if (previousReservation.moreStops && previousReservation.moreStops.length > 0) {
			previousEndLocation = previousReservation.moreStops[previousReservation.moreStops.length - 1].geo;
		} else {
			previousEndLocation = previousReservation.dest.geo;
		}

		totalNonTripDistance += getDistance(previousEndLocation, currentReservation.origin.geo);
	}

	return totalNonTripDistance;
}

function isPointWithinPolygon(lat, lng, polygon) {
	// pointsWithinPolygon() function returns a FeatureCollection object, which contains multiple features.
	// A point is a feature with type == 'point'. If the given point is within the TPE airport polygon,
	// then the point will be returned by the function.
	return pointsWithinPolygon(turfHelpers.points([[lat, lng]]), polygon).features.length > 0;
}

function isAtAirport(lat, lng) {
	return isAtTpeAirport(lat, lng) || isAtTsaAirport(lat, lng);
}

function isAtTpeAirport(lat, lng) {
	const westPointOfTpeAirport = [25.073411557289983, 121.20115851519779];
	const tpeAirport = turfHelpers.polygon([
		[
			westPointOfTpeAirport,
			[25.04704685442329, 121.22049174044349],
			[25.082577, 121.254746],
			[25.1018, 121.245344],
			westPointOfTpeAirport,
		],
	]);
	return isPointWithinPolygon(lat, lng, tpeAirport);
}

function isAtTsaAirport(lat, lng) {
	const southestPoint = [25.061906, 121.551024];
	const tsaAirport = turfHelpers.polygon([
		[
			southestPoint,
			[25.065614, 121.564189],
			[25.067638, 121.564986],
			[25.068502, 121.567924],
			[25.070073, 121.567268],
			[25.070483, 121.556657],
			[25.071913, 121.556281],
			[25.071828, 121.550312],
			[25.070795, 121.54978],
			[25.071106, 121.539263],
			[25.069082, 121.539185],
			[25.068364, 121.542092],
			southestPoint,
		],
	]);
	// pointsWithinPolygon() function returns a FeatureCollection object, which contains multiple features.
	// A point is a feature with type == 'point'. If the given point is within the TPE airport polygon,
	// then the point will be returned by the function.
	return isPointWithinPolygon(lat, lng, tsaAirport);
}

function isInTamshuiRegion(lat, lng) {
	const tamshuiRegion = turfHelpers.polygon([
		[
			[25.130194861587853, 121.45540994306995],
			[25.206634003668945, 121.55978006025745],
			[25.318803499891114, 121.53849404951526],
			[25.25423476712394, 121.44099038740589],
			[25.18093250424265, 121.39567178389026],
			[25.16943619731041, 121.43000405928089],
			[25.157006537928797, 121.44596856733753],
			[25.130194861587853, 121.45540994306995],
		],
	]);
	return isPointWithinPolygon(lat, lng, tamshuiRegion);
}

function isWithinApproximateTaiwanBoundary(lat, lng) {
	const TAIWAN_BOUNDS = {
		minLat: 21.5, // Southernmost point
		maxLat: 25.5, // Northernmost point
		minLon: 120.0, // Westernmost point
		maxLon: 122.0, // Easternmost point
	};

	return (
		lat >= TAIWAN_BOUNDS.minLat &&
		lat <= TAIWAN_BOUNDS.maxLat &&
		lng >= TAIWAN_BOUNDS.minLon &&
		lng <= TAIWAN_BOUNDS.maxLon
	);
}

function isInNangangNeihuRegion(lat, lng) {
	const nangangNeihuRegion = turfHelpers.polygon([
		[
			[25.109954227027444, 121.59478912353518],
			[25.09285479291086, 121.5628601074219],
			[25.076063932315865, 121.56423339843752],
			[25.07295426094415, 121.57041320800784],
			[25.06331377790402, 121.56972656250002],
			[25.05258396128981, 121.57212982177737],
			[25.052117426214064, 121.57504806518557],
			[25.052739472587128, 121.5796829223633],
			[25.03532098111078, 121.58860931396487],
			[25.01476452655086, 121.6013122558594],
			[25.017253450809832, 121.6342712402344],
			[25.022075597977825, 121.66568527221682],
			[25.030319475303603, 121.66774520874026],
			[25.032030399312845, 121.66190872192385],
			[25.029075151948557, 121.65040740966799],
			[25.03934044222359, 121.62637481689455],
			[25.041206766346797, 121.62225494384768],
			[25.04804971180118, 121.6177917480469],
			[25.050771231683626, 121.61693344116213],
			[25.053725956290524, 121.62131080627444],
			[25.05574756893072, 121.62139663696291],
			[25.057069374550853, 121.62354240417483],
			[25.061889956587326, 121.62028083801272],
			[25.06383368601418, 121.61659011840823],
			[25.065233152107098, 121.61873588562014],
			[25.067254574906606, 121.61882171630862],
			[25.069509199445903, 121.62234077453616],
			[25.082958338658578, 121.62903556823733],
			[25.089332559065124, 121.62920722961428],
			[25.098504635041788, 121.62697563171389],
			[25.108764108486064, 121.60843620300295],
			[25.109954227027444, 121.59478912353518],
		],
	]);
	return isPointWithinPolygon(lat, lng, nangangNeihuRegion);
}

function isInLinkouPlateauRegion(lat, lng) {
	const linkouPlateauRegion = turfHelpers.polygon([
		[
			[25.087957696514458, 121.35000000000002],
			[25.067745384494895, 121.34176025390627],
			[25.03944254405566, 121.34004364013674],
			[25.032599118339323, 121.35240325927737],
			[25.03322126372537, 121.37746582031252],
			[25.041930967837136, 121.40081176757815],
			[25.05250620556714, 121.40184173583987],
			[25.064013515918216, 121.3874221801758],
			[25.070544211317916, 121.40184173583987],
			[25.086403021755725, 121.41008148193362],
			[25.101948880496348, 121.37849578857424],
			[25.087957696514458, 121.35000000000002],
		],
	]);
	return isPointWithinPolygon(lat, lng, linkouPlateauRegion);
}

function isInXinzhuangRegion(lat, lng) {
	const xinzhuangRegion = turfHelpers.polygon([
		[
			[25.034741831867652, 121.41097817684617],
			[25.021831828704297, 121.40634331966844],
			[25.01949855070655, 121.40702996517625],
			[25.007520358909883, 121.42797265316453],
			[24.99709682592887, 121.4291742828032],
			[24.995229831125794, 121.43827233578172],
			[25.014676302313188, 121.44084725643602],
			[25.029453561068184, 121.45046029354539],
			[25.03349755336263, 121.45492348934617],
			[25.039563291868383, 121.4676264312407],
			[25.04065198241357, 121.47037301327195],
			[25.06568919705393, 121.47105965877977],
			[25.06911003413113, 121.46127496029344],
			[25.061024265274924, 121.45097527767625],
			[25.057447697296027, 121.4427355315825],
			[25.03489736579345, 121.42556939388719],
			[25.034741831867652, 121.41097817684617],
		],
	]);
	return isPointWithinPolygon(lat, lng, xinzhuangRegion);
}

function isInYilanRegion(lat, lng) {
	const yilanRegion = turfHelpers.polygon([
		[
			[24.98940418682416, 121.94375558988945],
			[24.894768216128767, 121.78582712309257],
			[24.80878583724834, 121.64575143949882],
			[24.78509904301796, 121.59631296293632],
			[24.736464615834265, 121.5949396719207],
			[24.672837044318218, 121.48782297270195],
			[24.660357239790216, 121.45349069731132],
			[24.58919853526764, 121.40405222074882],
			[24.43800832411102, 121.32165475981132],
			[24.39424173637012, 121.32440134184257],
			[24.354623311388618, 121.46642444593002],
			[24.309576328599547, 121.79738758069564],
			[24.585861480070754, 121.92098377210189],
			[24.98940418682416, 121.94375558988945],
		],
	]);
	return isPointWithinPolygon(lat, lng, yilanRegion);
}

function isInHsinchuSouthRegion(lat, lng) {
	const hsinchuSouthRegion = turfHelpers.polygon([
		[
			[24.817442847048827, 120.8549395164863],
			[24.776302603207203, 120.98952203601755],
			[24.697724277861703, 121.06230645984567],
			[24.55665802844799, 121.00600152820505],
			[24.474191812327888, 120.9757891258613],
			[24.474191812327888, 120.94008355945505],
			[24.311600366847053, 120.86476785441077],
			[24.23210476336481, 120.85584146280921],
			[24.17887128761223, 120.8551548173014],
			[24.173859933745668, 120.81395608683265],
			[24.192025155166366, 120.77441969133197],
			[24.186387949430404, 120.76274671769916],
			[24.123735578636037, 120.75656690812885],
			[24.065441325325533, 120.72978773332416],
			[23.981955005225426, 120.71742811418353],
			[24.00077472417294, 120.61580457902728],
			[24.038405904619186, 120.48808851457416],
			[24.129929048251814, 120.50456800676166],
			[24.221386749861445, 120.40431776262103],
			[24.817442847048827, 120.8549395164863],
		],
	]);
	return isPointWithinPolygon(lat, lng, hsinchuSouthRegion);
}

function parseTaiwaneseAddress(address) {
	if (address.includes("桃園國際機場") || address.includes("桃園機場")) {
		return {
			summary: "桃園機場",
		};
	} else if (address.includes("松山國際機場") || address.includes("松山機場")) {
		return {
			summary: "松山機場",
		};
	}

	const regex = /^(.*?)(縣|市)(.*?)(區|鎮|鄉|市)/;
	const match = regex.exec(address);

	if (match) {
		const administrativeArea = match[1].slice(-2); // 縣市
		const administrativeAreaType = match[2];
		const subdivision = match[3]; // 區/鎮/鄉/市
		const subdivisionType = match[4];
		let summary = administrativeArea + administrativeAreaType + subdivision + subdivisionType;
		if (summary == null) {
			summary = address;
		}
		return {
			administrativeArea,
			administrativeAreaType,
			subdivision,
			subdivisionType,
			summary,
		};
	}

	const shortRegex = /^(.*?)(區|鎮|鄉|市)/;
	const shortMatch = shortRegex.exec(address);

	if (shortMatch) {
		const subdivision = shortMatch[1]; // 區/鎮/鄉/市
		const subdivisionType = shortMatch[2];
		let summary = subdivision + subdivisionType;
		if (summary == null) {
			summary = address;
		}
		return {
			subdivision,
			subdivisionType,
			summary,
		};
	}

	return { summary: address };
}

function getReservationCategory(reservation) {
	if (isAtTpeAirport(reservation.dest.geo.lat, reservation.dest.geo.lng)) {
		return {
			purpose: ENUM_RESERVATION_LOCATION_TYPE.AIRPORT_DEPARTURE,
			airport: ENUM_AIRPORT_CODE.TPE,
		};
	}

	if (isAtTpeAirport(reservation.origin.geo.lat, reservation.origin.geo.lng)) {
		return {
			purpose: ENUM_RESERVATION_LOCATION_TYPE.AIRPORT_ARRIVAL,
			airport: ENUM_AIRPORT_CODE.TPE,
		};
	}

	if (isAtTsaAirport(reservation.dest.geo.lat, reservation.dest.geo.lng)) {
		return {
			purpose: ENUM_RESERVATION_LOCATION_TYPE.AIRPORT_DEPARTURE,
			airport: ENUM_AIRPORT_CODE.TSA,
		};
	}

	if (isAtTsaAirport(reservation.origin.geo.lat, reservation.origin.geo.lng)) {
		return {
			purpose: ENUM_RESERVATION_LOCATION_TYPE.AIRPORT_ARRIVAL,
			airport: ENUM_AIRPORT_CODE.TSA,
		};
	}

	return {
		purpose: ENUM_RESERVATION_LOCATION_TYPE.INTRA_CITY,
		airport: ENUM_AIRPORT_CODE.UNSPECIFIED,
	};
}

module.exports = {
	getDistance,
	sanitizeLocation,
	hasArrivedAtLocation,
	getReservationDistance,
	estimatePointToPointDuration,
	getRawTimeEstimate,
	getPointToPointDurationBreakdown,
	areEqualLatLng,
	isLightHourStartTime,
	estTime,
	estimateReservationDuration,
	isAtAirport,
	isAtTpeAirport,
	isAtTsaAirport,
	parseTaiwaneseAddress,
	isWithinApproximateTaiwanBoundary,
	calculateNonTripDistance,
	isInHsinchuSouthRegion,
	getReservationCategory,
};
