const Moment = require("moment");
const MomentTZ = require("moment-timezone");
const _ = require("lodash");
const Helper = require("./helper");
const Enum = require("./enum");
const Env = require("./environment");
const { TAIPEI_TIMEZONE } = require("../constants/constants");
const {
	ENTERPRISE_ID_ASUS,
	ENTERPRISE_ID_ZEMO,
	ENTERPRISE_ID_AUO,
	ENTERPRISE_ID_GOGORO,
	ENTERPRISE_ID_PEGATRON,
	ENTERPRISE_ID_MSI,
	ENTERPRISE_ID_KKDAY,
	ENTERPRISE_ID_KLOOK,
	ENTERPRISE_ID_24TMS,
} = require("../constants/enterprise");
const { estimateReservationDuration, parseTaiwaneseAddress, isAtAirport, isInHsinchuSouthRegion } = require("./geo");
const camelcaseKeysDeep = require("camelcase-keys-deep");
const { MAIOLI_BOUNDARY_LAT } = require("./reservation-config-deps");

function isReservationsTimeOverlapping(time1, time2) {
	const time2Moment = Moment.unix(time2);

	return (
		Moment.unix(time1).add(1, "h").isSameOrAfter(time2Moment) &&
		Moment.unix(time1).subtract(1, "h").isSameOrBefore(time2Moment)
	);
}

// Return true if the reservation is in the future and within Zemo service hour, thus will be guaranteed a reservation.
// Return false if this reservation needs to be inserted into the realtime request queue.
function isAssignableFutureReservation(reservation) {
	const scheduleType = Enum.ENUM_SCHEDULE_TYPE[Env.schedulingAlgo];

	// Same day is not assignable.
	if (MomentTZ.unix(reservation.reservationTime).tz("Asia/Taipei").isSame(MomentTZ.tz("Asia/Taipei"), "date")) {
		return false;
	}
	// Next day is assignable only if the reservation is made before 5:30pm.
	const tomorrow = Moment().tz("Asia/Taipei").add(1, "d");
	if (MomentTZ.unix(reservation.reservationTime).tz("Asia/Taipei").isSame(tomorrow, "date")) {
		const now = Moment().tz("Asia/Taipei");
		const today7pm = now.clone().startOf("d").add(17, "h").add(30, "m");
		if (now > today7pm) {
			return false;
		} else {
			return true;
		}
	} else {
		// Reservation in the day after tomorrow are assignable.
		return true;
	}
}

function isEveningBeforeReservation(reservationTime) {
	const now = Moment().tz(TAIPEI_TIMEZONE);
	const previous530pm = MomentTZ.unix(reservationTime).tz(TAIPEI_TIMEZONE).startOf("day").subtract(6.5, "h");
	if (now > previous530pm) {
		return true;
	} else {
		return false;
	}
}

// private
function getReadableIntermediateStops(reservation) {
	// If there are more stops between the origin and the destination, create a non-empty string to print out the
	// intermediate stops.
	return reservation.moreStops?.length > 0
		? "\n" +
				_.join(
					_.map(reservation.moreStops, (value, index) => {
						return `中途停靠/Intermediate Stop ${index + 1}：${value.address}`;
					}),
					"。\n"
				) +
				"。"
		: "";
}

function formatReservationId(reservation) {
	let responseId = reservation.requestId || reservation.id || "";
	let idString = responseId === "" ? "" : `預約編號/Trip Number：${responseId}`;
	return idString;
}

function sanitizeReservation(reservation) {
	let camelcaseReservation = camelcaseKeysDeep(_.cloneDeep(reservation));
	let sanitizedReservation = _.cloneDeep(camelcaseReservation);
	if (_.isString(camelcaseReservation.origin)) {
		sanitizedReservation.origin = JSON.parse(camelcaseReservation.origin);
		sanitizedReservation.dest = JSON.parse(camelcaseReservation.dest);
		sanitizedReservation.moreStops = JSON.parse(camelcaseReservation.moreStops);
	}
	return sanitizedReservation;
}

/**
 * @function formatReservationForTapPay
 * @description 格式化預約資訊用於 TapPay 付款，確保回傳值小於 100 字符
 * @param {Object} reservation - 預約物件
 * @returns {string} 格式化的預約資訊，長度限制在 100 字符以內
 */
function formatReservationForTapPay(reservation) {
	const sanitizedReservation = sanitizeReservation(reservation);
	const flightNumber = sanitizedReservation.extension.flightNumber;
	const flightNumberNote = flightNumber != null ? `航班:${flightNumber}。` : "";
	const originAddress = sanitizedReservation.origin.address;
	const originAddressSummary = parseTaiwaneseAddress(originAddress);
	const destinationAddress = sanitizedReservation.dest.address;
	const destinationAddressSummary = parseTaiwaneseAddress(destinationAddress);

	// 組合基本資訊
	let result =
		`${formatReservationId(sanitizedReservation)}` +
		`時間: ${MomentTZ.unix(sanitizedReservation.reservationTime).tz("Asia/Taipei").format("YYYY-MM-DD HH:mm")} ` +
		`${originAddressSummary.summary}->${destinationAddressSummary.summary}。${flightNumberNote}`;

	// 如果超過 100 字符，進行截斷處理
	if (result.length > 100) {
		// 簡化時間格式
		const shortTime = MomentTZ.unix(sanitizedReservation.reservationTime).tz("Asia/Taipei").format("MM/DD HH:mm");
		result =
			`${formatReservationId(sanitizedReservation)}` +
			`時間: ${shortTime} ` +
			`${originAddressSummary.summary}->${destinationAddressSummary.summary}。${flightNumberNote}`;

		// 如果還是超過，截斷地址
		if (result.length > 100) {
			const maxAddressLength = 50; // 預留空間給其他資訊
			const truncatedOrigin =
				originAddressSummary.summary.length > maxAddressLength / 2
					? originAddressSummary.summary.substring(0, maxAddressLength / 2) + "..."
					: originAddressSummary.summary;
			const truncatedDest =
				destinationAddressSummary.summary.length > maxAddressLength / 2
					? destinationAddressSummary.summary.substring(0, maxAddressLength / 2) + "..."
					: destinationAddressSummary.summary;

			result =
				`${formatReservationId(sanitizedReservation)}` +
				`時間: ${shortTime} ` +
				`${truncatedOrigin}->${truncatedDest}。${flightNumberNote}`;
		}
	}

	// 最終確保不超過 100 字符
	return result.length > 100 ? result.substring(0, 97) + "..." : result;
}

function formatReadableBasicReservationInfo(reservation, includeNotes) {
	// 防護措施：檢查 reservation 是否存在
	if (!reservation) {
		return "預約編號：N/A\n時間：N/A\n起點：N/A\n終點：N/A";
	}

	const sanitizedReservation = sanitizeReservation(reservation);

	let note =
		sanitizedReservation.note !== "" && includeNotes == true
			? "\n" + `備註/Other Notes：${sanitizedReservation.note}。`
			: "";
	let flightNumber = sanitizedReservation.extension?.flightNumber;
	const flightNumberNote = flightNumber != null ? "\n" + `航班編號/Flight Number：${flightNumber}。` : "";

	// 防護措施：檢查必要的屬性是否存在
	const reservationId = formatReservationId(sanitizedReservation);
	const reservationTime = sanitizedReservation.reservationTime
		? MomentTZ.unix(sanitizedReservation.reservationTime).tz("Asia/Taipei").format("YYYY-MM-DD HH:mm")
		: "N/A";
	const originAddress = sanitizedReservation.origin?.address || "N/A";
	const destAddress = sanitizedReservation.dest?.address || "N/A";
	const intermediateStops = getReadableIntermediateStops(sanitizedReservation);

	return (
		`${reservationId}` +
		"\n" +
		`時間/Pickup Time：${reservationTime}。
起點/Pickup Location：${originAddress}。${intermediateStops}
終點/Dropoff Location：${destAddress}。${note}${flightNumberNote}`
	);
}

function getReadableReservationWithPassengerInfo(reservation) {
	// 防護措施：檢查 reservation 和 passengerUser 是否存在
	if (!reservation) {
		return "預約資訊不完整";
	}

	const passengerName = reservation.passengerUser?.username || "N/A";
	const passengerPhone = reservation.passengerUser?.phone || "N/A";

	return `${formatReadableBasicReservationInfo(reservation)}
乘客姓名/Passenger Name：${passengerName}。
乘客電話/Passenger Phone：${passengerPhone}。`;
}

function getReadableReservationWithBothPassengerAndDriverInfo(reservation) {
	const brand = reservation?.driverUser?.description?.brand || null;
	const color = reservation?.driverUser?.description?.color || null;
	const licenseNum = reservation?.driverUser?.description?.licenseNum || null;

	return `${formatReadableBasicReservationInfo(reservation)}
乘客姓名/Passenger Name：${reservation.passengerUser.username}。
乘客電話/Passenger Phone：${reservation.passengerUser.phone}。
駕駛姓名/Driver Name：${reservation?.driverUser?.username}。
駕駛電話/Driver Phone：${reservation?.driverUser?.phone}。
車牌號碼/License Plate Number: ${licenseNum}。
品牌外觀/Brand and Color: ${`${brand}(${color})`}。`;
}

function getReadableReservationWithDriverInfo(reservation, includeNotes) {
	const brand = reservation?.driverUser?.description?.brand || null;
	const color = reservation?.driverUser?.description?.color || null;
	const licenseNum = reservation?.driverUser?.description?.licenseNum || null;

	return `${formatReadableBasicReservationInfo(reservation, includeNotes)}
駕駛姓名/Driver Name：${reservation?.driverUser?.username}。
駕駛電話/Driver Phone：${reservation?.driverUser?.phone}。
車牌號碼/License Plate Number: ${licenseNum}。
品牌外觀/Brand and Color: ${`${brand}(${color})`}。`;
}

function getReadableReservationWithDriverInfoChinese(reservation, includeNotes) {
	const sanitizedReservation = sanitizeReservation(reservation);
	const brand = reservation?.driverUser?.description?.brand || null;
	const color = reservation?.driverUser?.description?.color || null;
	const licenseNum = reservation?.driverUser?.description?.licenseNum || null;

	let note =
		sanitizedReservation.note !== "" && includeNotes == true ? "\n" + `備註：${sanitizedReservation.note}。` : "";
	let flightNumber = sanitizedReservation.extension?.flightNumber;
	const flightNumberNote = flightNumber != null ? "\n" + `航班編號：${flightNumber}。` : "";
	const requestId = sanitizedReservation.requestId || sanitizedReservation.id || "";
	const idString = requestId === "" ? "" : `預約編號：${requestId}`;

	return (
		`${idString}` +
		"\n" +
		`時間：${MomentTZ.unix(sanitizedReservation.reservationTime).tz("Asia/Taipei").format("YYYY-MM-DD HH:mm")}。
起點：${sanitizedReservation.origin.address}。${getReadableIntermediateStops(sanitizedReservation).replace(
			/中途停靠\/Intermediate Stop/g,
			"中途停靠"
		)}
終點：${sanitizedReservation.dest.address}。${note}${flightNumberNote}
駕駛姓名：${reservation?.driverUser?.username}。
駕駛電話：${reservation?.driverUser?.phone}。
車牌號碼：${licenseNum}。
品牌外觀：${`${brand}(${color})`}。`
	);
}

function getReadableReservationWithDriverInfoEnglish(reservation, includeNotes) {
	const sanitizedReservation = sanitizeReservation(reservation);
	const brand = reservation?.driverUser?.description?.brand || null;
	const color = reservation?.driverUser?.description?.color || null;
	const licenseNum = reservation?.driverUser?.description?.licenseNum || null;

	let note =
		sanitizedReservation.note !== "" && includeNotes == true
			? "\n" + `Other Notes: ${sanitizedReservation.note}`
			: "";
	let flightNumber = sanitizedReservation.extension?.flightNumber;
	const flightNumberNote = flightNumber != null ? "\n" + `Flight Number: ${flightNumber}` : "";
	const requestId = sanitizedReservation.requestId || sanitizedReservation.id || "";
	const idString = requestId === "" ? "" : `Trip Number: ${requestId}`;

	// Convert intermediate stops to English format
	const intermediateStops =
		reservation.moreStops?.length > 0
			? "\n" +
			  _.join(
					_.map(reservation.moreStops, (value, index) => {
						return `Intermediate Stop ${index + 1}: ${value.address}`;
					}),
					"\n"
			  )
			: "";

	// Format driver phone with international format
	const driverPhone = reservation?.driverUser?.phone;
	let formattedDriverPhone = driverPhone;
	if (driverPhone && driverPhone.startsWith("+886")) {
		// Convert +886912345678 to +886-912345678
		formattedDriverPhone = driverPhone.replace(/^\+886(\d{9})$/, "+886-$1");
	}

	return (
		`${idString}` +
		"\n" +
		`Pickup Time: ${MomentTZ.unix(sanitizedReservation.reservationTime)
			.tz("Asia/Taipei")
			.format("YYYY-MM-DD HH:mm")}
Pickup: ${sanitizedReservation.origin.address}${intermediateStops}
Dropoff Location: ${sanitizedReservation.dest.address}${note}${flightNumberNote}
Driver Phone: ${formattedDriverPhone}
License Plate: ${licenseNum}
Brand and Color: ${`${brand}(${color})`}`
	);
}

function hasDuplicateRequestIds(reservations) {
	const sortedRequestIds = _.map(reservations, (res) => {
		if (res.hasOwnProperty("requestId")) {
			return res.requestId;
		} else {
			return null;
		}
	})
		.filter((requestId) => {
			return requestId != null;
		})
		.sort();
	const hasDupes = sortedRequestIds.some((value, index, arr) => {
		if (index > 0) {
			return value == arr[index - 1];
		} else {
			return false;
		}
	});
	return hasDupes;
}

function isEligibleReservation(reservation, enterpriseId) {
	// Allow ASUS to make reservations that start and end outside Taipei proper.
	if (
		_.includes(
			[
				ENTERPRISE_ID_ASUS,
				ENTERPRISE_ID_ZEMO,
				ENTERPRISE_ID_AUO,
				ENTERPRISE_ID_GOGORO,
				ENTERPRISE_ID_PEGATRON,
				ENTERPRISE_ID_MSI,
			],
			enterpriseId
		)
	) {
		return true;
	}

	// Check if any location is north of the boundary OR within Hsinchu-South polygon
	if (
		reservation.origin.geo.lat >= MAIOLI_BOUNDARY_LAT ||
		isInHsinchuSouthRegion(reservation.origin.geo.lat, reservation.origin.geo.lng)
	) {
		return true;
	}
	if (
		reservation.dest.geo.lat >= MAIOLI_BOUNDARY_LAT ||
		isInHsinchuSouthRegion(reservation.dest.geo.lat, reservation.dest.geo.lng)
	) {
		return true;
	}
	if (reservation.moreStops == null || reservation.moreStops.length == 0) {
		return true;
	}

	for (let stop of reservation.moreStops) {
		if (stop.geo.lat >= MAIOLI_BOUNDARY_LAT || isInHsinchuSouthRegion(stop.geo.lat, stop.geo.lng)) {
			return true;
		}
	}
	return false;
}

function convertReservationToLeave(reservation) {
	return {
		from: reservation.reservationTime,
		to: reservation.reservationTime + estimateReservationDuration(reservation),
		driverId: reservation.driverId,
	};
}

function populateInternalReservationTime(reservation) {
	if (isAtAirport(reservation.origin.geo.lat, reservation.origin.geo.lng)) {
		// 機場接機：全時段 +20 分鐘 buffer（旅客通關 + 領行李）
		// 修正：原版 reservationDay630am 使用 reservationMoment.clone().add(6,"h").add(30,"m")
		// 導致 06:30 以後的預約永遠無法觸發 isAfter 條件，buffer 不生效。
		// 現改為不分時段一律加 20 分鐘。
		reservation.internalReservationTime = reservation.reservationTime + 60 * 20;
	} else {
		reservation.internalReservationTime = reservation.reservationTime;
	}
	reservation.internalReservationTimeHumanReadable = MomentTZ.unix(reservation.internalReservationTime)
		.tz(TAIPEI_TIMEZONE)
		.format("YYYY-MM-DD HH:mm");
}

/**
 * Generate a trip URL for the given reservation public ID
 * @param {string} publicId - The public ID of the reservation
 * @returns {string} - The complete trip URL
 */
function generateTripUrl(publicId) {
	const baseUrl = "https://www.zemotw.com";
	return `${baseUrl}/trip/${publicId}`;
}

/**
 * Check if an enterprise is tourism industry based on enterprise ID or name
 * @param {number} enterpriseId - The enterprise ID
 * @param {string} enterpriseName - The enterprise name
 * @returns {boolean} - True if it's tourism industry
 */
function isTourismIndustryEnterprise(enterpriseId, enterpriseName = "") {
	// Check by enterprise ID
	const tourismEnterpriseIds = [ENTERPRISE_ID_KKDAY, ENTERPRISE_ID_KLOOK, ENTERPRISE_ID_24TMS];
	if (enterpriseId && tourismEnterpriseIds.includes(enterpriseId)) {
		return true;
	}

	// Check by enterprise name containing "旅遊業"
	if (enterpriseName && enterpriseName.includes("旅遊業")) {
		return true;
	}

	return false;
}

/**
 * Get the appropriate customer service LINE@ based on enterprise type
 * @param {number} enterpriseId - The enterprise ID
 * @param {string} enterpriseName - The enterprise name
 * @returns {string} - The customer service LINE@ ID
 */
function getCustomerServiceLineId(enterpriseId, enterpriseName = "") {
	return isTourismIndustryEnterprise(enterpriseId, enterpriseName) ? "@zemorideservice" : "@zemoservice";
}

/**
 * Generate simplified next-day reservation reminder SMS message
 * Format:
 * 明日行程提醒
 * 預約編號：32136
 * 時間：07/25 11:29
 * 起點：[地址]
 * 終點：[地址]
 * 客服LINE@：@zemoservice。
 *
 * @param {Object} reservation - The reservation object
 * @returns {string} - The formatted SMS message
 */
function getNextDayReminderSmsMessage(reservation) {
	const sanitizedReservation = sanitizeReservation(reservation);
	const requestId = sanitizedReservation.requestId || sanitizedReservation.id || "";
	const customerServiceLineId = getCustomerServiceLineId(
		reservation.enterpriseId,
		reservation.passengerEnterpriseName
	);

	// Format time as MM/DD HH:mm (shorter format)
	const formattedTime = MomentTZ.unix(sanitizedReservation.reservationTime).tz(TAIPEI_TIMEZONE).format("MM/DD HH:mm");

	return `明日行程提醒
預約編號：${requestId}
時間：${formattedTime}
起點：${sanitizedReservation.origin.address}
終點：${sanitizedReservation.dest.address}
客服LINE@：${customerServiceLineId}。`;
}

/**
 * Generate driver arrival SMS message
 * Format:
 * 駕駛已抵達
 * 起點：[地址]
 * 駕駛資訊：呂怡萱 (電話: 0920996260)
 * 車輛資訊：白色NISSAN LEAF 車牌RED-1392
 *
 * @param {Object} reservation - The reservation object
 * @returns {string} - The formatted SMS message
 */
function getDriverArrivalSmsMessage(reservation) {
	const sanitizedReservation = sanitizeReservation(reservation);
	const driverName = reservation?.driverUser?.username || "未知";
	const driverPhone = reservation?.driverUser?.phone || "未提供";
	const brand = reservation?.driverUser?.description?.brand || "未知";
	const color = reservation?.driverUser?.description?.color || "未知";
	const licenseNum = reservation?.driverUser?.description?.licenseNum || "未知";

	return `駕駛已抵達
起點：${sanitizedReservation.origin.address}
駕駛資訊：${driverName} (電話: ${driverPhone})
車輛資訊：${color}${brand} 車牌${licenseNum}`;
}

/**
 * @function getAirportNameByAddress
 * @description 根據地址字串識別並回傳對應的機場名稱，如果無法識別則回傳原始地址
 *
 * @param {string} address - 需要識別的地址字串
 *
 * @returns {string} 機場名稱或原始地址：
 *   - "桃園機場" - 當地址包含桃園機場相關關鍵字時
 *   - "松山機場" - 當地址包含松山機場相關關鍵字時
 *   - 原始地址 - 當無法識別為任何已知機場時
 *
 * @example
 * getAirportNameByAddress("台北市松山區敦化北路338號"); // 回傳 "松山機場"
 * getAirportNameByAddress("桃園市大園區航站南路9號"); // 回傳 "桃園機場"
 * getAirportNameByAddress("台北市信義區信義路五段7號"); // 回傳 "台北市信義區信義路五段7號"
 */
const getAirportNameByAddress = (address) => {
	if (
		address.includes("航站南路9號") ||
		address.includes("桃園機場") ||
		address.includes("桃園國際機場") ||
		address.includes("TPE") ||
		address.includes("Taoyuan International Airport") ||
		(address.includes("大園區") && address.includes("航站"))
	) {
		return "桃園機場";
	}

	if (
		address.includes("敦化北路338號") ||
		address.includes("敦化北路340") ||
		address.includes("松山機場") ||
		address.includes("臺北松山機場") ||
		address.includes("TSA") ||
		address.includes("Taipei Songshan Airport") ||
		address.includes("臺北國際航空站")
	) {
		return "松山機場";
	}
	return address;
};

/**
 * @function cleanAddress
 * @description 清理地址中開頭的數字和「台灣」文字
 * @param {string} address - 原始地址字串
 * @returns {string} 清理後的地址字串
 */
const cleanAddress = (address) => {
	if (!address) return "";

	// 步驟1：移除開頭的數字（只限定開頭）
	let cleanedAddress = address.replace(/^\d+/, "");

	// 步驟2：移除「台灣」或「台湾」（不限位置）
	cleanedAddress = cleanedAddress.replace(/台灣|台湾/g, "");

	// 例如：10491台灣台北市中山區民權東路二段135巷29弄12號 -> 台北市中山區民權東路二段135巷29弄12號
	// 例如：33758台灣桃園市大園區航站南路9號 -> 桃園市大園區航站南路9號
	// 例如：237新北市三峽區復興路167號 -> 新北市三峽區復興路167號
	return getAirportNameByAddress(cleanedAddress);
};

/**
 * @function formatReservationInfoForNotification
 * @description 將預約資訊格式化為通知用的文字格式，包含企業、時間、起點、停靠點和終點資訊
 * 支援 snake_case 和 camelCase 兩種欄位命名格式
 * @param {Object} reservation - 預約物件
 * @param {number} reservation.id|reservation.reservationId|reservation.reservation_id - 預約編號
 * @param {Object} reservation.passenger - 乘客資訊
 * @param {string} reservation.passenger.enterprise.name|reservation.passengerEnterpriseName - 企業名稱
 * @param {number} reservation.reservationTime|reservation.reservation_time - 預約時間戳記
 * @param {Object} reservation.origin - 起點資訊
 * @param {string} reservation.origin.address - 起點地址
 * @param {Object} reservation.dest - 終點資訊
 * @param {string} reservation.dest.address - 終點地址
 * @param {Array} [reservation.moreStops|reservation.more_stops] - 停靠點陣列
 * @returns {string} 格式化的預約資訊文字，用於通知訊息
 * @example
 * const notificationText = formatReservationInfoForNotification(reservation);
 * console.log(notificationText); // 企業：XXX公司\n時間：2024-01-01 10:00:00\n起點：台北車站\n停靠點：信義區、松山區\n終點：桃園機場
 */
function formatReservationInfoForNotification(reservation) {
	const reservationId = reservation?.id || reservation?.reservationId || reservation?.reservation_id || "";
	const enterpriseName =
		reservation?.passengerUser?.passenger?.enterprise?.name || reservation?.passengerEnterpriseName || "未知";

	// 支援 snake_case 和 camelCase 兩種時間欄位格式
	const reservationTime = reservation.reservationTime || reservation?.reservation_time;
	const timeFormatted = MomentTZ.unix(reservationTime).tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");

	const originAddress = reservation?.origin?.address || "未知";
	const destAddress = reservation?.dest?.address || "未知";

	// 支援 snake_case 和 camelCase 兩種停靠點欄位格式
	const moreStops = reservation?.moreStops || reservation?.more_stops;
	const moreStopsText =
		moreStops && moreStops.length > 0
			? `\n${moreStops.map((stop, index) => `停靠點${index + 1}: ${cleanAddress(stop.address)}`).join("\n")}`
			: "";

	return `預約編號：${reservationId}
企業：${enterpriseName}
時間：${timeFormatted}
起點：${cleanAddress(originAddress)}${moreStopsText}
終點：${cleanAddress(destAddress)}`;
}

/**
 * Get the Chinese display name for vehicle type
 * @param {string} vehicleType - The vehicle type (STANDARD or LARGE)
 * @returns {string} The Chinese display name
 */
function getVehicleTypeDisplayName(vehicleType) {
	if (vehicleType === Enum.VEHICLE_TYPE.LARGE) {
		return "七人座";
	}
	return "五人座";
}

module.exports = {
	hasDuplicateRequestIds,
	isReservationsTimeOverlapping,
	isAssignableFutureReservation,
	isEveningBeforeReservation,
	formatReservationId,
	formatReservationForTapPay,
	formatReadableBasicReservationInfo,
	formatReservationInfoForNotification,
	getReadableReservationWithPassengerInfo,
	getReadableReservationWithBothPassengerAndDriverInfo,
	getReadableReservationWithDriverInfo,
	getReadableReservationWithDriverInfoChinese,
	getReadableReservationWithDriverInfoEnglish,
	convertReservationToLeave,
	populateInternalReservationTime,
	isEligibleReservation,
	generateTripUrl,
	getNextDayReminderSmsMessage,
	getDriverArrivalSmsMessage,
	cleanAddress,
	getVehicleTypeDisplayName,
};
