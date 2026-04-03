/* eslint-disable prettier/prettier */
const _ = require("lodash");
const Moment = require("moment");
const CryptoJS = require("crypto-js");
const ChangeCaseLib = require("change-case");

const Helper = {
	/**
	 * @param {string} title
	 * @param {Array|Object|string} log
	 */
	Print: (title, log, ...rest) => {
		const time = Moment().format("MM/DD HH:mm");
		const logs = _.compact(_.concat(log, rest));
		console.group(`${title}, ${time}`);
		logs.forEach((el) => console.log(el));
		console.groupEnd();
		console.log("\n");
	},

	Wait: (milliseconds = 0, callback = () => {}) =>
		new Promise((resolve, reject) => {
			setTimeout(() => {
				resolve(callback());
			}, milliseconds);
		}),

	/**
	 * 回傳 error code
	 * @param {object} res
	 * @param {object} error - {code, message}
	 * @param {message} message
	 */
	SendError: (res, error = {}, message = "invalid") => {
		const errorMsg = typeof error === "string" ? error : _.get(error, "message", message);
		const errorCode = _.get(error, "code");

		if (_.isNumber(errorCode)) {
			return res.status(errorCode).send({
				success: false,
				code: errorCode,
				message: errorMsg,
			});
		}

		return res.status(404).send({
			success: false,
			code: 404,
			message: errorMsg,
		});
	},

	/**
	 * 將userId轉換為uuid
	 * @param {number} userId
	 * @param {string} uuid
	 */
	toUUID: (userId) => {
		if (!userId) {
			return null;
		}
		return Helper.Encrypt(userId, process.env.USER_UUID_HASH);
	},

	/**
	 * 將uuid轉換為userId
	 * @param {string} uuid
	 * @param {number} userId
	 */
	toUserId: (uuid) => {
		if (!uuid) {
			return null;
		}
		return Helper.Decrypt(uuid, process.env.USER_UUID_HASH);
	},

	Encrypt: (string = "", secret = "") => {
		try {
			const key = CryptoJS.enc.Utf8.parse(CryptoJS.MD5(secret).toString());
			const iv = CryptoJS.enc.Utf8.parse(CryptoJS.MD5(key).toString().substr(0, 16));
			const srcs = CryptoJS.enc.Utf8.parse(string);
			const encrypted = CryptoJS.AES.encrypt(srcs, key, {
				iv,
				mode: CryptoJS.mode.CBC,
				padding: CryptoJS.pad.Pkcs7,
			});
			return encrypted.ciphertext.toString();
		} catch (error) {
			console.log(error);
			return string;
		}
	},

	Decrypt: (ciphertext = "", secret = "") => {
		try {
			const key = CryptoJS.enc.Utf8.parse(CryptoJS.MD5(secret).toString());
			const iv = CryptoJS.enc.Utf8.parse(CryptoJS.MD5(key).toString().substr(0, 16));
			const encryptedHexStr = CryptoJS.enc.Hex.parse(ciphertext);
			const srcs = CryptoJS.enc.Base64.stringify(encryptedHexStr);
			const decrypt = CryptoJS.AES.decrypt(srcs, key, {
				iv,
				mode: CryptoJS.mode.CBC,
				padding: CryptoJS.pad.Pkcs7,
			});
			return decrypt.toString(CryptoJS.enc.Utf8);
		} catch (error) {
			return ciphertext;
		}
	},
	/**
	 * 更改Object propName. ex: 'camelCase', 'snakeCase', ...
	 * @param {object} obj
	 * @param {string} funcName - function name
	 * @param {function} adapterFunc - (key, value) => newValue
	 * @param {boolean} deepChange - 深層改變名稱
	 * @returns {object}
	 */
	ChangeCase: (data, funcName, adapterFunc, deepChange) => {
		// value 轉換器
		const adapter = _.isFunction(adapterFunc) ? adapterFunc : (key, value) => value;

		// 指定的case function
		const caseName = funcName || "snakeCase";

		// 限定 array or object
		if (!_.isObject(data)) return data;

		if (_.isArray(data)) {
			return data.map((item) => Helper.ChangeCase(item, caseName, adapter, deepChange));
		}

		const newObj = {};
		// Loop Object
		Object.keys(data).forEach((key) => {
			// key 轉換case
			const propName = ChangeCaseLib[caseName](key);

			const value = data[key];

			let processedValue = adapter(propName, value);
			// value轉換 fallback
			if (_.isNil(processedValue)) {
				processedValue = value;
			}

			newObj[propName] = deepChange
				? Helper.ChangeCase(processedValue, caseName, adapter, deepChange)
				: processedValue;
		});

		return newObj;
	},
	/**
	 *  Safe Parse Json
	 * @param {string} str
	 * @param {any} fallback
	 * @returns {object} json format
	 */
	ParseJson: (str, fallback = {}) => {
		try {
			if (_.isObject(str)) {
				throw new Error("value is object");
			}

			const validStr = _.replace(str, /\bNaN\b/g, "null");
			const json = JSON.parse(validStr);
			const isSameType =
				(_.isArray(json) && _.isArray(fallback)) || (_.isPlainObject(json) && _.isPlainObject(fallback));

			return isSameType ? json : fallback;
		} catch (error) {
			// 已經是object
			const isSameType =
				(_.isArray(str) && _.isArray(fallback)) || (_.isPlainObject(str) && _.isPlainObject(fallback));

			return isSameType ? str : fallback;
		}
	},

	GetInsertUpdateSQL: (props = [], tableName = "", ignore = false) => {
		if (_.isEmpty(props) || !tableName) {
			throw new Error("props cannot be empty array.");
		}

		let sql = `INSERT ${ignore ? "IGNORE" : ""} INTO ${tableName} (`;
		props.forEach((prop, index) => {
			sql += ` ${prop}`;
			if (index !== props.length - 1) {
				sql += `,`;
			}
		});

		sql += `) VALUES ? `;

		if (!ignore) {
			sql += `ON DUPLICATE KEY UPDATE `;
			props.forEach((prop, index) => {
				sql += `${prop}=VALUES(${prop})`;
				if (index !== props.length - 1) {
					sql += `,`;
				}
			});
		}

		return sql;
	},

	/**
	 * 取得sql, 並轉換成[[value, value...]]
	 * @param {Array|Object} value [{}]
	 * @param {string} tableName
	 * @return {Object} { sql, dataSet }
	 */
	GetInsertUpdateWith: (value, tableName, ignore = false) => {
		const arr = _.isArray(value) ? value : [value];
		const values = arr.filter((el) => _.isPlainObject(el));

		if (_.isEmpty(values) || !tableName) {
			throw new Error(`getInsertUpdateWith no value ${values} with table ${tableName}`);
		}

		const keys = Object.keys(values[0]);
		const sql = Helper.GetInsertUpdateSQL(keys, tableName, ignore);
		const dataSet = values.map((obj) => keys.map((key) => obj[key]));

		return { sql, dataSet };
	},

	ContainsChinese: (str = null) => {
		const REGEX_CHINESE =
			/[\u4e00-\u9fff]|[\u3400-\u4dbf]|[\u{20000}-\u{2a6df}]|[\u{2a700}-\u{2b73f}]|[\u{2b740}-\u{2b81f}]|[\u{2b820}-\u{2ceaf}]|[\uf900-\ufaff]|[\u3300-\u33ff]|[\ufe30-\ufe4f]|[\uf900-\ufaff]|[\u{2f800}-\u{2fa1f}]/u;
		return REGEX_CHINESE.test(str);
	},

	ExtractEmail: (str = "") => {
		if (!str) {
			return [];
		}
		const result = str.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi);
		if (_.isEmpty(result)) {
			return [];
		}
		return result;
	},

	ValidateEmail: (email) => {
		const re =
			/^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
		return re.test(email);
	},

	IsValueEmpty: (value) => {
		return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
	},

	ToBool: (value) => {
		if (value !== undefined) {
			if (value === 0 || value === false || value === "false" || value === "FALSE") {
				return false;
			}
			if (value === 1 || value === true || value === "true" || value === "TRUE") {
				return true;
			}
		}

		return false;
	},
};
module.exports = Helper;
