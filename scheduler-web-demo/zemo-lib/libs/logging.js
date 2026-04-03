const bunyan = require("bunyan");
const { Writable } = require("stream");

// Imports the Google Cloud client library for Bunyan
const { LoggingBunyan } = require("@google-cloud/logging-bunyan");

const Env = require("../libs/environment");

// 更嚴格的雲端日誌大小控制（留更大安全邊界，避免 256KB 限制）
// GCP 單筆 entry 限制是 256KB，但 JSON 結構 + metadata 開銷會額外吃掉空間
const MAX_ENTRY_BYTES = 200 * 1024; // 200KB 為整筆 log 上限（含結構開銷）
const MAX_STRING_BYTES = 16 * 1024; // 單一字串最多 16KB
const MAX_ARRAY_ITEMS = 3; // 陣列最多保留前 3 筆
const MAX_OBJECT_KEYS = 20; // 物件最多保留 20 個鍵
const MAX_DEPTH = 3; // 最大遞迴深度

/**
 * @function isErrorLike
 * @description 檢查值是否為 Error 物件或類似 Error 的物件
 * @param {*} value - 要檢查的值
 * @returns {boolean} 是否為 Error-like 物件
 */
function isErrorLike(value) {
	return value instanceof Error || (value && typeof value === "object" && "stack" in value && "message" in value);
}

/**
 * @function safeString
 * @description 安全截斷字串，避免超過最大字節限制
 * @param {string} str - 要處理的字串
 * @param {number} max - 最大字節數，預設為 MAX_STRING_BYTES
 * @returns {string} 截斷後的安全字串
 */
function safeString(str, max = MAX_STRING_BYTES) {
	if (typeof str !== "string") return str;
	if (str.length <= max) return str;
	return str.slice(0, max - 200) + `... [TRUNCATED string, original length=${str.length}]`;
}

/**
 * @function sanitizeValue
 * @description 遞迴清理值，避免循環引用、過深巢狀和過大的資料結構
 * @param {*} value - 要清理的值
 * @param {number} depth - 當前遞迴深度，預設為 0
 * @param {WeakSet} seen - 用於偵測循環引用的 WeakSet
 * @returns {*} 清理後的安全值
 */
function sanitizeValue(value, depth = 0, seen = new WeakSet()) {
	if (value === null || value === undefined) return value;

	if (typeof value === "string") {
		return safeString(value);
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return value;
	}

	if (Buffer.isBuffer(value)) {
		return `[Buffer length=${value.length}]`;
	}

	if (isErrorLike(value)) {
		return {
			name: value.name || "Error",
			message: safeString(String(value.message || "")),
			stack: safeString(String(value.stack || ""), 16 * 1024), // stack 再小一點
		};
	}

	if (typeof value === "function") {
		return `[Function ${value.name || "anonymous"}]`;
	}

	if (typeof value === "object") {
		if (seen.has(value)) return "[Circular]";
		if (depth >= MAX_DEPTH) return "[MaxDepthReached]";
		seen.add(value);

		if (Array.isArray(value)) {
			const originalLength = value.length;
			const limited = value.slice(0, MAX_ARRAY_ITEMS).map((v) => sanitizeValue(v, depth + 1, seen));
			if (originalLength > MAX_ARRAY_ITEMS) {
				limited.push(`...[${originalLength - MAX_ARRAY_ITEMS} more items omitted]`);
			}
			return limited;
		}

		// 一般物件：限制鍵數量
		const result = {};
		const keys = Object.keys(value);
		const limitedKeys = keys.slice(0, MAX_OBJECT_KEYS);
		for (const key of limitedKeys) {
			try {
				result[key] = sanitizeValue(value[key], depth + 1, seen);
			} catch (e) {
				result[key] = `[SanitizeError: ${e && e.message ? e.message : "unknown"}]`;
			}
		}
		if (keys.length > MAX_OBJECT_KEYS) {
			result.__truncatedKeys = keys.length - MAX_OBJECT_KEYS;
		}
		return result;
	}

	return String(value);
}

/**
 * FORMATTING HELPER FUNCTIONS
 * These helpers eliminate code duplication across logging functions
 */

/**
 * @function formatUnixTimeToHHMM
 * @description Formats Unix timestamp to HH:mm format in Taipei timezone
 * @param {number} unixTimestamp - Unix timestamp in seconds
 * @returns {string} Time in HH:mm format or "N/A" if invalid
 */
function formatUnixTimeToHHMM(unixTimestamp) {
	if (!unixTimestamp) return "N/A";
	const MomentTZ = require("moment-timezone");
	const { TAIPEI_TIMEZONE } = require("../constants/constants");
	return MomentTZ.unix(unixTimestamp).tz(TAIPEI_TIMEZONE).format("HH:mm");
}

/**
 * @function truncateAddress
 * @description Truncates address string to specified length with ellipsis
 * @param {string} address - Address string to truncate
 * @param {number} maxLength - Maximum length (default: 20)
 * @returns {string} Truncated address or empty string if invalid
 */
function truncateAddress(address, maxLength = 20) {
	if (!address || typeof address !== "string") return "";
	if (address.length <= maxLength) return address;
	return address.substring(0, maxLength) + "...";
}

/**
 * @function roundCoordinate
 * @description Rounds a coordinate to 4 decimal places
 * @param {number} coordinate - Latitude or longitude value
 * @returns {number|null} Rounded coordinate or null if invalid
 */
function roundCoordinate(coordinate) {
	if (coordinate === null || coordinate === undefined || typeof coordinate !== "number") {
		return null;
	}
	return parseFloat(coordinate.toFixed(4));
}

/**
 * @function getReservationStatusName
 * @description Converts reservation status code to human-readable name
 * @param {number} statusCode - Reservation status code (1-13)
 * @returns {string} Status name (e.g., "BOOKED", "WAITING") or "UNKNOWN" if invalid
 */
function getReservationStatusName(statusCode) {
	const { ENUM_RESERVATION_STATUS } = require("./enum");
	const statusName = Object.keys(ENUM_RESERVATION_STATUS).find(
		(key) => ENUM_RESERVATION_STATUS[key] === statusCode
	);
	return statusName || "UNKNOWN";
}

/**
 * @function roundGeoCoordinates
 * @description Rounds both lat and lng coordinates in a geo object
 * @param {Object} geo - Geo object with lat and lng properties
 * @returns {Object} Object with rounded lat and lng, or nulls if invalid
 */
function roundGeoCoordinates(geo) {
	return {
		lat: roundCoordinate(geo?.lat),
		lng: roundCoordinate(geo?.lng),
	};
}

/**
 * @function formatHourMinuteToHHMM
 * @description Formats hour/minute object to HH:mm string
 * @param {Object} timeObj - Object with hour and minute properties
 * @returns {string} Time in HH:mm format or "N/A" if invalid
 */
function formatHourMinuteToHHMM(timeObj) {
	if (!timeObj || timeObj.hour === undefined || timeObj.minute === undefined) {
		return "N/A";
	}
	return `${String(timeObj.hour).padStart(2, "0")}:${String(timeObj.minute).padStart(2, "0")}`;
}

/**
 * @function safeJsonStringifyMap
 * @description Safely maps array items and stringifies, with fallback on error
 * @param {Array} items - Array of items to map
 * @param {Function} mapFn - Mapping function to apply to each item
 * @param {Function} fallbackFn - Fallback mapping function if main mapping fails
 * @returns {string} JSON stringified mapped array
 */
function safeJsonStringifyMap(items, mapFn, fallbackFn) {
	try {
		const mapped = items.map(mapFn);
		return JSON.stringify(mapped);
	} catch (error) {
		return JSON.stringify(items.map(fallbackFn));
	}
}

/**
 * @function estimateSizeBytes
 * @description 估算物件序列化後的字節大小
 * @param {*} obj - 要估算的物件
 * @returns {number} 估算的字節大小
 */
function estimateSizeBytes(obj) {
	try {
		return Buffer.byteLength(JSON.stringify(obj), "utf8");
	} catch (_) {
		// 若序列化失敗，回傳一個較大的值以觸發截斷
		return MAX_ENTRY_BYTES * 2;
	}
}

/**
 * @function buildSafeRecord
 * @description 建立安全的日誌記錄，確保不超過大小限制
 * @param {Array} args - 傳入 logger 的參數陣列
 * @returns {Object} 包含 record 和 message 的物件
 *   - record {Object} - 結構化的日誌欄位
 *   - message {string} - 日誌訊息
 */
function buildSafeRecord(args) {
	// 先對每個引數做遞迴清理
	const sanitizedArgs = args.map((a) => sanitizeValue(a));

	// Bunyan 慣例：第一個 object 參數會做為結構化欄位，其後為 message/format
	let record = {};
	const messageParts = [];

	if (sanitizedArgs.length > 0 && typeof sanitizedArgs[0] === "object" && !Array.isArray(sanitizedArgs[0])) {
		record = sanitizedArgs[0] || {};
		for (let i = 1; i < sanitizedArgs.length; i += 1) {
			const part = sanitizedArgs[i];
			if (typeof part === "string") {
				messageParts.push(part);
			} else {
				messageParts.push(safeString(JSON.stringify(part)));
			}
		}
	} else {
		for (const part of sanitizedArgs) {
			if (typeof part === "string") {
				messageParts.push(part);
			} else {
				messageParts.push(safeString(JSON.stringify(part)));
			}
		}
	}

	let message = messageParts.join(" ");
	// 初步大小估計
	let approx = estimateSizeBytes({ ...record, msg: message });

	if (approx > MAX_ENTRY_BYTES) {
		// 若仍然過大，直接替換為一個固定的、非常小的概要物件
		const argTypes = args.map((a) => (a === null ? "null" : Array.isArray(a) ? "array" : typeof a));
		record = {
			truncated: true,
			note: "Log entry exceeded safe size and was summarized",
			argCount: args.length,
			argTypes,
		};
		message = `[TRUNCATED LOG from original size approx. ${(approx / 1024).toFixed(2)}KB]`;
	}

	return { record, message };
}

/**
 * @function createSafeLogger
 * @description 創建安全的日誌包裝器，確保所有日誌操作都被 try-catch 保護
 * @param {Object} bunyanLogger - Bunyan logger 實例
 * @returns {Object} 包裝後的安全 logger 物件
 */
function createSafeLogger(bunyanLogger) {
	const wrap = (level) => {
		return (...args) => {
			try {
				const { record, message } = buildSafeRecord(args);

				// 確保 record 和 message 都是可序列化的
				try {
					JSON.stringify(record);
				} catch (serializeError) {
					// 如果 record 無法序列化，使用最小化版本
					const safeRecord = {
						serializationError: true,
						errorMessage: String(serializeError.message),
						originalArgCount: args.length,
					};
					bunyanLogger[level](safeRecord, "[SERIALIZATION_ERROR] Unable to serialize log record");
					return;
				}

				// 實際寫入日誌
				bunyanLogger[level](record, message);
			} catch (e) {
				// 第一層錯誤處理：嘗試記錄錯誤資訊
				try {
					bunyanLogger[level](
						{
							loggerWrapError: true,
							errorMessage: String(e && e.message),
							errorStack: e && e.stack ? String(e.stack).substring(0, 500) : undefined,
						},
						"logger wrap error"
					);
				} catch (fallbackError) {
					// 第二層錯誤處理：最後手段，直接輸出到 console
					try {
						console.error("[LOGGER_CRITICAL_ERROR]", {
							originalError: String(e && e.message),
							fallbackError: String(fallbackError && fallbackError.message),
							level,
							timestamp: new Date().toISOString(),
						});
					} catch (_) {
						// 完全靜默處理，避免系統崩潰
					}
				}
			}
		};
	};

	// Create the base logger object with standard methods
	const logger = {
		info: wrap("info"),
		error: wrap("error"),
		warn: wrap("warn"),
		debug: wrap("debug"),
		fatal: wrap("fatal"),
		trace: wrap("trace"),
	};

	// Add the logReservationDetails method to the logger
	logger.logReservationDetails = function (reservation, logLevel = "info", messagePrefix = "Reservation Details") {
		if (!reservation || typeof reservation !== "object") {
			logger.warn({ reservation }, `${messagePrefix} - Invalid reservation object provided`);
			return;
		}

		try {
			// Flatten the reservation object
			const flattenedReservation = flattenObject(reservation);

			// Create a structured log entry with flattened fields
			const logData = {
				reservationId: reservation.id || flattenedReservation.id,
				...flattenedReservation,
			};

			// Log the flattened reservation data
			logger[logLevel](logData, messagePrefix);
		} catch (error) {
			logger.error(
				{
					error: error.message,
					reservationId: reservation.id || "unknown",
					hasReservation: !!reservation,
				},
				`${messagePrefix} - Failed to log reservation details`
			);
		}
	};

	return logger;
}

/**
 * @function createSafeCloudStream
 * @description 創建安全的 Cloud Logging stream wrapper，防止 gRPC 錯誤導致系統崩潰
 * @param {Object} loggingBunyan - LoggingBunyan 實例
 * @returns {Object} Bunyan stream 配置對象
 */
function createSafeCloudStream(loggingBunyan) {
	// loggingBunyan.stream() 返回的是一個配置對象: { level, type, stream }
	const streamConfig = loggingBunyan.stream("info");
	const baseStream = streamConfig.stream;

	// 監聽 baseStream 的錯誤事件，防止未捕獲的錯誤
	if (baseStream && typeof baseStream.on === "function") {
		baseStream.on("error", (err) => {
			console.error("[CLOUD_LOGGING_STREAM_ERROR]", {
				message: err.message,
				code: err.code,
				timestamp: new Date().toISOString(),
			});
		});

		// 監聽 drain 事件，追蹤寫入背壓情況
		baseStream.on("drain", () => {
			// Drain 事件觸發，表示可以繼續寫入
		});
	}

	// 追蹤併發寫入統計
	let concurrentWrites = 0;
	let totalWrites = 0;
	let pendingWrites = 0;

	// 創建安全的 wrapper stream
	const safeStream = new Writable({
		objectMode: true, // Bunyan 使用 object mode
		highWaterMark: 16, // 設置高水位標記，控制背壓
		write(record, encoding, callback) {
			try {
				// 估算大小（將 object 序列化）
				const sizeBytes = estimateSizeBytes(record);

				// 更新統計
				totalWrites++;
				pendingWrites++;
				concurrentWrites = pendingWrites;

				// 如果待處理寫入過多，記錄警告
				if (pendingWrites > 5) {
					console.warn("[WARN] High concurrent write count:", {
						pendingWrites,
						concurrentWrites,
						totalWrites,
						timestamp: new Date().toISOString(),
					});
				}

				// 檢查大小，超過限制則跳過但不中斷
				if (sizeBytes > MAX_ENTRY_BYTES) {
					pendingWrites--; // 更新統計（跳過的日誌不算待處理）
					concurrentWrites = pendingWrites;
					console.warn("[SKIP_LARGE_LOG_ENTRY]", {
						sizeBytes,
						sizeKB: (sizeBytes / 1024).toFixed(2),
						maxBytes: MAX_ENTRY_BYTES,
						maxKB: (MAX_ENTRY_BYTES / 1024).toFixed(2),
						recordKeys: Object.keys(record || {}),
						msg: record?.msg || "N/A",
						pendingWrites,
						timestamp: new Date().toISOString(),
					});
					return callback(); // 跳過但不中斷
				}

				// 寫入到實際的 Cloud Logging stream
				if (baseStream && typeof baseStream.write === "function") {
					// 嘗試寫入
					// 注意：GCP logging 的 stream 使用內部緩衝機制，callback 可能不會立即被調用
					// 我們需要處理兩種情況：callback 被調用 vs callback 不被調用
					let callbackCalled = false;
					let immediateCallbackTimer = null;

					try {
						baseStream.write(record, encoding, (err) => {
							if (callbackCalled) {
								// 防止重複調用（以防 callback 和 immediateCallbackTimer 都觸發）
								return;
							}
							callbackCalled = true;

							// 清除計時器
							if (immediateCallbackTimer) clearTimeout(immediateCallbackTimer);

							// 更新統計
							pendingWrites--;
							concurrentWrites = pendingWrites;

							if (err) {
								// !! disabled cloud logging write error log
								// 啟用錯誤日誌，幫助診斷 GCP logging 寫入失敗
								// console.error("[CLOUD_LOGGING_WRITE_ERROR]", {
								// 	message: err.message,
								// 	code: err.code,
								// 	details: err.details,
								// 	sizeBytes,
								// 	recordKeys: Object.keys(record || {}),
								// 	msg: record?.msg || "N/A",
								// 	pendingWrites,
								// 	timestamp: new Date().toISOString(),
								// });
							}
							callback(); // 調用 callback 完成寫入流程
						});

						// GCP logging 使用內部緩衝機制，callback 可能不會立即被調用
						// 為了避免阻塞 stream，如果 callback 在 100ms 內沒有被調用，我們先調用 callback
						// 這樣可以讓 Bunyan 繼續處理下一個日誌，而不會被阻塞
						immediateCallbackTimer = setTimeout(() => {
							if (!callbackCalled) {
								// GCP logging 可能使用內部緩衝，callback 不會立即調用
								// 為了避免阻塞，我們先調用 callback
								callbackCalled = true;
								pendingWrites--;
								concurrentWrites = pendingWrites;
								callback(); // 調用 callback 避免阻塞
							}
						}, 100);
					} catch (writeError) {
						// 寫入時發生同步錯誤
						if (immediateCallbackTimer) clearTimeout(immediateCallbackTimer);
						pendingWrites--;
						concurrentWrites = pendingWrites;
						console.error("[CLOUD_LOGGING_WRITE_SYNC_ERROR]", {
							message: writeError.message,
							stack: writeError.stack,
							msg: record?.msg || "N/A",
							pendingWrites,
							timestamp: new Date().toISOString(),
						});
						callback(); // 即使有錯誤也要呼叫 callback
					}
				} else {
					// baseStream 不存在或不可寫入
					console.warn("[WARN] baseStream not available for GCP logging:", {
						msg: record?.msg || "N/A",
						hasBaseStream: !!baseStream,
						hasWriteMethod: baseStream && typeof baseStream.write === "function",
						timestamp: new Date().toISOString(),
					});
					callback();
				}
			} catch (err) {
				console.error("[SAFE_STREAM_ERROR]", {
					message: err.message,
					timestamp: new Date().toISOString(),
				});
				callback(); // swallow error，避免系統崩潰
			}
		},
	});

	// 監聽 safeStream 的錯誤事件
	safeStream.on("error", (err) => {
		console.error("[SAFE_STREAM_WRAPPER_ERROR]", {
			message: err.message,
			timestamp: new Date().toISOString(),
		});
	});

	// 返回 Bunyan stream 配置對象
	return {
		level: "info",
		type: "raw",
		stream: safeStream,
	};
}

/**
 * @function createLogger
 * @description 創建一個安全的日誌記錄器，支援開發、測試和生產環境
 * @param {string} logName - 日誌記錄器的名稱
 * @returns {Object} 日誌記錄器物件，包含 info, error, warn, debug, fatal, trace 和 logReservationDetails 方法
 */
function createLogger(logName) {
	if (process.env.NODE_ENV === "test") {
		const testLogger = {
			info: () => {},
			error: () => {},
			warn: () => {},
			debug: () => {},
			fatal: () => {},
			trace: () => {},
		};

		// Add logReservationDetails method to test logger as well
		testLogger.logReservationDetails = () => {};

		return testLogger;
	}

	let bunyanLogger;

	// 在測試環境或禁用雲端日誌時，使用 console logging（不包含 setTimeout）
	if (Env.isDev || process.env.DISABLE_CLOUD_LOGGING === "true" || process.env.NODE_ENV === "test") {
		// Use console logging for development or when cloud logging is disabled
		bunyanLogger = bunyan.createLogger({
			name: logName,
			streams: [
				{
					level: "info",
					stream: process.stdout,
				},
			],
			environment: process.env.DISABLE_CLOUD_LOGGING === "true" ? "testing" : "development",
		});
	} else {
		// Use Google Cloud Logging for production
		const loggingBunyan = new LoggingBunyan({ projectId: Env.gcpProjectId });

		// 使用安全的 stream wrapper 防止 gRPC 錯誤導致系統崩潰
		const safeStreamConfig = createSafeCloudStream(loggingBunyan);

		bunyanLogger = bunyan.createLogger({
			name: logName,
			projectId: Env.gcpProjectId,
			streams: [safeStreamConfig],
			environment: "production",
		});
	}

	// 返回包裝後的日誌器
	return createSafeLogger(bunyanLogger);
}

/**
 * @function flattenObject
 * @description 將巢狀物件扁平化為點符號表示法
 * @param {Object} obj - 要扁平化的物件
 * @param {string} prefix - 鍵的前綴，預設為空字串
 * @param {Object} result - 累積結果的物件，預設為空物件
 * @returns {Object} 扁平化後的物件
 * @example
 * flattenObject({ a: { b: { c: 1 } } })
 * // 返回 { 'a.b.c': 1 }
 */
function flattenObject(obj, prefix = "", result = {}) {
	for (const key in obj) {
		if (obj.hasOwnProperty(key)) {
			const newKey = prefix ? `${prefix}.${key}` : key;
			const value = obj[key];

			if (value === null || value === undefined) {
				result[newKey] = value;
			} else if (
				typeof value === "object" &&
				!Array.isArray(value) &&
				!Buffer.isBuffer(value) &&
				!isErrorLike(value)
			) {
				// Recursively flatten nested objects
				flattenObject(value, newKey, result);
			} else {
				// For arrays, primitive values, buffers, and error-like objects, store as-is
				result[newKey] = value;
			}
		}
	}
	return result;
}

/**
 * FLATTEN SCHEDULE RESULT FOR CLOUD LOGGING
 *
 * Converts nested schedule result objects into a flat structure optimized for Google Cloud Logging.
 * Prevents truncation issues caused by deeply nested JSON structures.
 *
 * OUTPUT FORMAT:
 * - Summary statistics (counts, totals, metrics)
 * - Driver schedules as JSON string (avoids depth truncation)
 * - Driver metrics as JSON string (avoids depth truncation)
 * - Unassigned reservation IDs array
 * - Human-readable times in HH:mm format (Taipei timezone)
 * - Maximum 2 nesting levels (avoids MAX_DEPTH = 3 limit)
 *
 * @param {Object} scheduleResponse - Schedule response object from computeSchedule
 * @param {string} label - Label for the schedule type (e.g., "live", "shadow")
 * @deprecated The 'label' parameter is not used and will be removed in a future version
 * @returns {Object} Flattened schedule with summary, driverSchedulesJson (string), unassigned, and driverMetricsJson (string)
 */
function flattenScheduleResultForLogging(scheduleResponse, label = "schedule") {
	const scheduleResult = scheduleResponse?.scheduleResult || {};
	const schedule = scheduleResult.schedule || {};

	// Calculate summary statistics
	const driverIds = Object.keys(schedule);
	const driversWithAssignments = driverIds.length;

	let totalReservationsAssigned = 0;
	for (const driverId of driverIds) {
		const driverSchedule = schedule[driverId];
		const reservations = driverSchedule.reservations || driverSchedule || [];
		totalReservationsAssigned += Array.isArray(reservations) ? reservations.length : 0;
	}

	const unassignedReservations = scheduleResult.unassignedReservations || [];
	const totalReservationsUnassigned = unassignedReservations.length;
	const totalNonTripDistance = scheduleResult.totalNonTripDistance || 0;

	// Format driver schedules with human-readable times
	const driverSchedules = {};
	const driverMetrics = {};

	for (const driverId of driverIds) {
		const driverSchedule = schedule[driverId];
		const reservations = driverSchedule.reservations || driverSchedule || [];

		// Extract key reservation identifiers with human-readable times
		const formattedReservations = Array.isArray(reservations)
			? reservations.map((res) => {
					// Format intermediate stops if any
					const moreStops = res.moreStops || [];
					const formattedStops = moreStops.map((stop) => {
						return {
							lat: roundCoordinate(stop.geo?.lat),
							lng: roundCoordinate(stop.geo?.lng),
							addr: truncateAddress(stop.address || "", 20),
						};
					});

					return {
						resId: res.id,
						enterpriseId: res.enterpriseId,
						driverId: res.driverId,
						status: getReservationStatusName(res.status),
						time: formatUnixTimeToHHMM(res.reservationTime),
						origin: truncateAddress(res.origin?.address || "", 20),
						dest: truncateAddress(res.dest?.address || "", 20),
						stops: formattedStops.length > 0 ? formattedStops : undefined,
					};
			  })
			: [];

		driverSchedules[driverId] = formattedReservations;

		// Collect driver metrics
		const nonTripDistance = scheduleResult.driverNonTripDistances?.[driverId] || 0;
		const homeToFirstDistance = scheduleResult.driverHomeToFirstDistances?.[driverId] || 0;

		driverMetrics[driverId] = {
			nonTripKm: parseFloat(nonTripDistance.toFixed(2)),
			homeToFirstKm: parseFloat(homeToFirstDistance.toFixed(2)),
			numReservations: formattedReservations.length,
		};
	}

	// Extract unassigned reservation IDs as comma-separated string to prevent GCP logging truncation
	const unassignedReservationIds = unassignedReservations.map((res) => res.id).join(",");

	// Serialize nested objects as JSON strings to avoid depth truncation
	// The logging sanitizer has MAX_DEPTH = 3, and nested objects would exceed this
	return {
		summary: {
			driversWithAssignments,
			totalReservationsAssigned,
			totalReservationsUnassigned,
			totalNonTripKm: parseFloat(totalNonTripDistance.toFixed(2)),
		},
		driverSchedulesJson: JSON.stringify(driverSchedules),
		unassignedReservationIds,
		driverMetricsJson: JSON.stringify(driverMetrics),
	};
}

/**
 * FLATTEN RESERVATIONS FOR CLOUD LOGGING
 *
 * Converts an array of reservation objects into a flattened structure optimized for Google Cloud Logging.
 * Extracts essential fields and formats them for readability while avoiding MAX_DEPTH truncation.
 *
 * EXTRACTED FIELDS PER RESERVATION:
 * - id: Reservation identifier
 * - enterpriseId: Enterprise identifier
 * - driverId: Current driver assignment (null if unassigned)
 * - status: Reservation status (human-readable: BOOKED, WAITING, etc.)
 * - time: Reservation time in HH:mm format (Taipei timezone)
 * - pickupLat/pickupLng: Origin coordinates (4 decimal precision)
 * - pickupAddr: Origin address (first 20 chars)
 * - dropoffLat/dropoffLng: Destination coordinates (4 decimal precision)
 * - dropoffAddr: Destination address (first 20 chars)
 * - stops: Array of intermediate stops with lat/lng/addr (only if present)
 * - reqVehicle: Required vehicle type (STANDARD/LARGE/null)
 *
 * @param {Array} reservations - Array of reservation objects to flatten
 * @returns {string} JSON string of flattened reservations (avoids depth truncation)
 */
function flattenReservationsForLogging(reservations) {
	const MomentTZ = require("moment-timezone");
	const { TAIPEI_TIMEZONE } = require("../constants/constants");

	if (!reservations || !Array.isArray(reservations) || reservations.length === 0) {
		return "[]";
	}

	try {
		const flattened = reservations.map((res) => {
			// Format reservation time in HH:mm Taipei timezone
			const time = res?.reservationTime
				? MomentTZ.unix(res.reservationTime).tz(TAIPEI_TIMEZONE).format("HH:mm")
				: "N/A";

			// Extract and truncate origin address (first 20 chars)
			const originAddr = res?.origin?.address || "";
			const pickupAddr = originAddr.length > 20 ? originAddr.substring(0, 20) + "..." : originAddr;

			// Extract and truncate destination address (first 20 chars)
			const destAddr = res?.dest?.address || "";
			const dropoffAddr = destAddr.length > 20 ? destAddr.substring(0, 20) + "..." : destAddr;

			// Format intermediate stops with details (lat/lng/addr)
			const moreStops = res?.moreStops || [];
			const formattedStops = moreStops.map((stop) => {
				return {
					lat: roundCoordinate(stop.geo?.lat),
					lng: roundCoordinate(stop.geo?.lng),
					addr: truncateAddress(stop.address || "", 20),
				};
			});

			return {
				id: res?.id,
				enterpriseId: res?.enterpriseId,
				driverId: res?.driverId,
				status: getReservationStatusName(res?.status),
				time: time,
				pickupLat: res?.origin?.geo?.lat ? parseFloat(res.origin.geo.lat.toFixed(4)) : null,
				pickupLng: res?.origin?.geo?.lng ? parseFloat(res.origin.geo.lng.toFixed(4)) : null,
				pickupAddr: pickupAddr,
				dropoffLat: res?.dest?.geo?.lat ? parseFloat(res.dest.geo.lat.toFixed(4)) : null,
				dropoffLng: res?.dest?.geo?.lng ? parseFloat(res.dest.geo.lng.toFixed(4)) : null,
				dropoffAddr: dropoffAddr,
				stops: formattedStops.length > 0 ? formattedStops : undefined,
				reqVehicle: res?.requiredVehicleType || null,
			};
		});

		return JSON.stringify(flattened);
	} catch (error) {
		// Fallback to minimal info if flattening fails
		return JSON.stringify(
			reservations.map((r) => ({
				id: r?.id,
				error: "Flattening failed",
			}))
		);
	}
}

/**
 * FLATTEN DRIVER SHIFTS FOR CLOUD LOGGING
 *
 * Converts an array of driver shift objects into a flattened structure optimized for Google Cloud Logging.
 * Extracts essential fields and formats them for readability while avoiding MAX_DEPTH truncation.
 *
 * EXTRACTED FIELDS PER DRIVER:
 * - driverId: Driver identifier
 * - name: Driver name from driverUser.username (if available)
 * - vehicleType: Vehicle type (STANDARD/LARGE)
 * - shiftStart/shiftEnd: Shift times in HH:mm format (Taipei timezone)
 * - homeLat/homeLng: Home location coordinates (4 decimal precision)
 * - homeAddr: Home location address (first 20 chars)
 *
 * @param {Array} driverShifts - Array of driver shift objects to flatten
 * @returns {string} JSON string of flattened driver shifts (avoids depth truncation)
 */
function flattenDriverShiftsForLogging(driverShifts) {
	if (!driverShifts || !Array.isArray(driverShifts) || driverShifts.length === 0) {
		return "[]";
	}

	try {
		const flattened = driverShifts.map((driver) => {
			// Extract driver name if available
			const name = driver?.driverUser?.username || driver?.name || "N/A";

			// Format shift times in HH:mm format
			const shiftBeginTime = driver?.shift?.shiftBeginTime;
			const shiftStart = shiftBeginTime
				? `${String(shiftBeginTime.hour).padStart(2, "0")}:${String(shiftBeginTime.minute).padStart(2, "0")}`
				: "N/A";

			const shiftEndTime = driver?.shift?.shiftEndTime;
			const shiftEnd = shiftEndTime
				? `${String(shiftEndTime.hour).padStart(2, "0")}:${String(shiftEndTime.minute).padStart(2, "0")}`
				: "N/A";

			// Extract and truncate home address (first 20 chars)
			const homeAddr = driver?.homeLocation?.address || "";
			const truncatedHomeAddr = homeAddr.length > 20 ? homeAddr.substring(0, 20) + "..." : homeAddr;

			return {
				driverId: driver?.driverId,
				name: name,
				vehicleType: driver?.vehicleType || "STANDARD",
				shiftStart: shiftStart,
				shiftEnd: shiftEnd,
				homeLat: driver?.homeLocation?.geo?.lat
					? parseFloat(driver.homeLocation.geo.lat.toFixed(4))
					: null,
				homeLng: driver?.homeLocation?.geo?.lng
					? parseFloat(driver.homeLocation.geo.lng.toFixed(4))
					: null,
				homeAddr: truncatedHomeAddr,
			};
		});

		return JSON.stringify(flattened);
	} catch (error) {
		// Fallback to minimal info if flattening fails
		return JSON.stringify(
			driverShifts.map((d) => ({
				driverId: d?.driverId,
				error: "Flattening failed",
			}))
		);
	}
}

module.exports = {
	createLogger,
	formatUnixTimeToHHMM,
	truncateAddress,
	flattenScheduleResultForLogging,
	flattenReservationsForLogging,
	flattenDriverShiftsForLogging,
};
