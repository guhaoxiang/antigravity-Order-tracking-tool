const _ = require("lodash");

const Moment = require("moment");
const MomentTZ = require("moment-timezone");
const { TAIPEI_TIMEZONE } = require("../constants/constants");

function reduceSchedule(schedule, leave) {
	const startOfDay = _.cloneDeep(MomentTZ.unix(leave.from).tz(TAIPEI_TIMEZONE)).startOf("day");
	const endOfDay = _.cloneDeep(startOfDay).endOf("day");

	// 將請假區間裁切在當天 [startOfDay, endOfDay] 範圍內，避免跨日假單把整天班表意外吃掉
	let from = MomentTZ.unix(leave.from).tz(TAIPEI_TIMEZONE);
	let to = MomentTZ.unix(leave.to).tz(TAIPEI_TIMEZONE);

	if (from.isBefore(startOfDay)) {
		from = startOfDay.clone();
	}
	if (to.isAfter(endOfDay)) {
		to = endOfDay.clone();
	}

	// 若裁切後區間已經無效（例如整段都在當天之外），就視為當天沒有請假
	if (!to.isAfter(from)) {
		return [schedule];
	}

	const shiftBeginTime = schedule.shift.shiftBeginTime;
	const shiftEndTime = schedule.shift.shiftEndTime;
	const tA = _.cloneDeep(startOfDay).add(shiftBeginTime.hour, "h").add(shiftBeginTime.minute, "m");
	const tB = _.cloneDeep(startOfDay).add(shiftEndTime.hour, "h").add(shiftEndTime.minute, "m");
	const tC = from;
	const tD = to;

	// overlap arithmetic
	if (tA.isBefore(tC)) {
		// A < C
		if (tB.isSameOrBefore(tC)) {
			// [A, B]
			// schedule: A=================B
			// leave:                          C======D
			// schedule: A=================B
			// leave:                      C======D
			return [schedule];
		} else if (tB.isSameOrBefore(tD)) {
			// [A, C]
			// schedule: A=================B
			// leave:          C=================D
			// schedule: A=================B
			// leave:          C===========D
			const reduction = _.cloneDeep(schedule);
			reduction.shift.shiftEndTime.hour = tC.hours();
			reduction.shift.shiftEndTime.minute = tC.minutes();
			return [reduction];
		} else {
			// [A, C] + [D, B]
			// schedule: A=================B
			// leave:          C======D
			const first = _.cloneDeep(schedule);
			first.shift.shiftEndTime.hour = tC.hours();
			first.shift.shiftEndTime.minute = tC.minutes();
			const second = _.cloneDeep(schedule);
			second.shift.shiftBeginTime.hour = tD.hours();
			second.shift.shiftBeginTime.minute = tD.minutes();
			return [first, second];
		}
	} else {
		// A >= C
		if (tD.isSameOrBefore(tA)) {
			// [A, B]
			// schedule:         A=================B
			// leave:     C======D
			return [schedule];
		} else if (tD.isBefore(tB)) {
			// [D, B]
			// schedule:  A=================B
			// leave:     C======D
			// schedule:       A=================B
			// leave:     C=================D
			const reduction = _.cloneDeep(schedule);
			reduction.shift.shiftBeginTime.hour = tD.hours();
			reduction.shift.shiftBeginTime.minute = tD.minutes();
			return [reduction];
		} else {
			// nothing
			// schedule:       A=================B
			// leave:    C===============================D
			return [];
		}
	}
}

function reduceSchedules(schedules, leave) {
	let result = [];
	for (let schedule of schedules) {
		result = result.concat(reduceSchedule(schedule, leave));
	}
	return _.filter(result, (schedule) => {
		const begin = schedule.shift.shiftBeginTime;
		const end = schedule.shift.shiftEndTime;
		const diff = (end.hour - begin.hour) * 60 - (end.minute - begin.minute);
		return diff >= 60;
	});
}

function reduceDriverSchedulesWithLeaves(schedules, leaves) {
	let result = [];
	for (let schedule of schedules) {
		const driverId = schedule.driverId;
		const leavesOfDriver = _.filter(leaves, (leave) => {
			return leave.driverId == driverId;
		});
		let intermediateSchedules = [schedule];
		for (let leave of leavesOfDriver) {
			intermediateSchedules = reduceSchedules(intermediateSchedules, leave);
		}
		result = result.concat(intermediateSchedules);
	}
	return result;
}

function getDriverIncome(pricing) {
	return _.get(
		pricing,
		// updated driver income
		"details.driverIncome",
		// legacy driver income
		pricing?.driverIncome
	);
}

module.exports = {
	reduceDriverSchedulesWithLeaves,
	getDriverIncome,
};
