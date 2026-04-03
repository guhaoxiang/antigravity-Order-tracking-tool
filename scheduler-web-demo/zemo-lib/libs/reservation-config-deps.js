const _ = require("lodash");
const Helper = require("./helper");
const { isInHsinchuSouthRegion } = require("./geo");

const MAIOLI_BOUNDARY_LAT = 24.5742625;

// Postal code sets for pickup and dropoff restrictions
const PICKUP_ALLOWED_ZIPS = new Set([
	// Taipei City (100-116)
	"100",
	"103",
	"104",
	"105",
	"106",
	"108",
	"110",
	"111",
	"112",
	"114",
	"115",
	"116",
	// New Taipei City (200-253)
	"200",
	"201",
	"202",
	"203",
	"204",
	"205",
	"206",
	"207",
	"208",
	"220",
	"221",
	"222",
	"223",
	"224",
	"226",
	"227",
	"228",
	"231",
	"232",
	"233",
	"234",
	"235",
	"236",
	"237",
	"238",
	"239",
	"241",
	"242",
	"243",
	"244",
	"247",
	"248",
	"249",
	"251",
	"252",
	"253",
	// Taoyuan (320-338)
	"320",
	"324",
	"325",
	"326",
	"327",
	"328",
	"330",
	"333",
	"334",
	"335",
	"336",
	"337",
	"338",
	// Hsinchu City & County (300-315)
	"300",
	"302",
	"303",
	"304",
	"305",
	"306",
	"307",
	"308",
	"310",
	"311",
	"312",
	"313",
	"314",
	"315",
]);

const DROPOFF_ALLOWED_ZIPS = new Set([
	// All pickup locations (北北基桃竹)
	...PICKUP_ALLOWED_ZIPS,
	// Miaoli Zhunan (350) - only this specific area in Miaoli
	"350",
	// Yilan County (260-272)
	"260",
	"261",
	"262",
	"263",
	"264",
	"265",
	"266",
	"267",
	"268",
	"269",
	"270",
	"272",
]);

/**
 * Check if pickup and dropoff locations are within allowed regions based on postal codes or polygon
 * @param {Object} reservation - Reservation object with origin, dest, and moreStops
 * @returns {Promise<Object>} - {isValid: boolean, errorMessage: string}
 */
async function checkLocationRestrictions(reservation) {
	const { geoClient } = require("./geo-client");
	try {
		// Check pickup location (origin)
		const originDetails = await geoClient.getRegionWithDetails(
			reservation.origin.geo.lat,
			reservation.origin.geo.lng
		);

		// Check if origin is valid (postal code OR within Hsinchu-South polygon)
		const isOriginInAllowedZip = PICKUP_ALLOWED_ZIPS.has(originDetails.postalCode);
		const isOriginInPolygon = isInHsinchuSouthRegion(reservation.origin.geo.lat, reservation.origin.geo.lng);

		if (!isOriginInAllowedZip && !isOriginInPolygon) {
			return {
				isValid: false,
				errorMessage: "上車點僅限於北北基桃竹以及苗栗台中市區",
			};
		}

		// Check dropoff location (destination)
		const destDetails = await geoClient.getRegionWithDetails(reservation.dest.geo.lat, reservation.dest.geo.lng);

		// Check if destination is valid (postal code OR within Hsinchu-South polygon)
		const isDestInAllowedZip = DROPOFF_ALLOWED_ZIPS.has(destDetails.postalCode);
		const isDestInPolygon = isInHsinchuSouthRegion(reservation.dest.geo.lat, reservation.dest.geo.lng);

		if (!isDestInAllowedZip && !isDestInPolygon) {
			return {
				isValid: false,
				errorMessage: "下車點僅限於北北基桃竹以及苗栗台中市區",
			};
		}

		// Check additional stops if any
		if (reservation.moreStops && reservation.moreStops.length > 0) {
			for (const stop of reservation.moreStops) {
				const stopDetails = await geoClient.getRegionWithDetails(stop.geo.lat, stop.geo.lng);

				// Check if stop is valid (postal code OR within Hsinchu-South polygon)
				const isStopInAllowedZip = DROPOFF_ALLOWED_ZIPS.has(stopDetails.postalCode);
				const isStopInPolygon = isInHsinchuSouthRegion(stop.geo.lat, stop.geo.lng);

				if (!isStopInAllowedZip && !isStopInPolygon) {
					return {
						isValid: false,
						errorMessage: "中途停靠點僅限於北北基桃竹以及苗栗台中市區",
					};
				}
			}
		}

		return {
			isValid: true,
			errorMessage: null,
		};
	} catch (error) {
		// If we can't determine the postal code, fall back to latitude check or polygon check
		// This maintains backward compatibility
		const isOriginValid =
			reservation.origin.geo.lat >= MAIOLI_BOUNDARY_LAT ||
			isInHsinchuSouthRegion(reservation.origin.geo.lat, reservation.origin.geo.lng);
		const isDestValid =
			reservation.dest.geo.lat >= MAIOLI_BOUNDARY_LAT ||
			isInHsinchuSouthRegion(reservation.dest.geo.lat, reservation.dest.geo.lng);

		if (isOriginValid && isDestValid) {
			if (reservation.moreStops) {
				for (let stop of reservation.moreStops) {
					const isStopValid =
						stop.geo.lat >= MAIOLI_BOUNDARY_LAT || isInHsinchuSouthRegion(stop.geo.lat, stop.geo.lng);
					if (!isStopValid) {
						return { isValid: false, errorMessage: "無法確認地點資訊，請確認上車及下車地點正確" };
					}
				}
			}
			return { isValid: true, errorMessage: null };
		}

		return { isValid: false, errorMessage: "無法確認地點資訊，請確認上車及下車地點正確" };
	}
}

async function getChineseAddress(placeId = null) {
	const { DB } = require("./database");
	const GoogleAPI = require("./googleAPI");
	/* db無紀錄則call API */
	const existData = await getPlaceDetailFromDB(placeId);
	if (!_.isEmpty(existData)) {
		return _.get(existData, "formattedAddress", null);
	}

	/* get place detail from API */
	const result = await GoogleAPI.getPlaceDetail(placeId);
	if (!_.isEmpty(result)) {
		/* 儲存資料 */
		await saveDetail(placeId, result);
		return _.get(result, "formatted_address", null);
	}
	/* no data */
	return null;

	async function getPlaceDetailFromDB(placeId = null) {
		const sql = `SELECT * FROM place_detail_zh WHERE place_id = :placeId`;
		const [info = {}] = await DB.query(sql, {
			placeId,
		});
		if (_.isEmpty(info)) {
			return {};
		}
		const detail = JSON.parse(info?.detail);
		return Helper.ChangeCase(detail, "camelCase");
	}

	function saveDetail(placeId = null, result = null) {
		const sql = `INSERT IGNORE INTO place_detail_zh SET ? `;
		return DB.query(sql, [
			{
				place_id: placeId,
				detail: JSON.stringify(result),
			},
		]);
	}
}

async function changeAddressLang(list = []) {
	await Promise.all(
		_.map(list, async (el) => {
			const { dest = {}, origin = {} } = el;
			/* check lang of origin address */
			if (!Helper.ContainsChinese(origin?.address)) {
				const zhOriAddress = await getChineseAddress(origin?.placeId);
				if (zhOriAddress) {
					origin.address = zhOriAddress;
				}
			}
			/* check lang of dest address */
			if (!Helper.ContainsChinese(dest?.address)) {
				const zhDestAddress = await getChineseAddress(dest?.placeId);
				if (zhDestAddress) {
					dest.address = zhDestAddress;
				}
			}
		})
	);
	return list;
}

module.exports = {
	checkLocationRestrictions,
	changeAddressLang,
	MAIOLI_BOUNDARY_LAT,
};
