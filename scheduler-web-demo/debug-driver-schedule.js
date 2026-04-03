const { fetchReservationsAndShifts } = require("./core/zemo-client");
const { runSchedule } = require("./core/scheduler-engine");

async function main() {
  const dateStr = process.argv[2] || "2026-03-17";
  const targetName = process.argv[3] || "陳威廷";

  const { reservations, driverShifts, driverMeta } =
    await fetchReservationsAndShifts(dateStr);
  const result = await runSchedule(reservations, driverShifts, {});

  const driver =
    (driverMeta || []).find((d) => {
      const name = d.username || d.name || "";
      return String(name).includes(targetName);
    }) || null;

  if (!driver) {
    console.log(
      JSON.stringify(
        { error: "driver_not_found", date: dateStr, targetName },
        null,
        2
      )
    );
    return;
  }

  const driverId = String(driver.id);
  const scheduleForDriver =
    (result.schedule && result.schedule[driverId]) ||
    result.schedule[Number(driverId)];
  const dbg =
    (result.debug && result.debug[driverId]) || result.debug[String(driverId)];

  const fmtTime = (ts) => {
    if (!ts) return null;
    const d = new Date(ts * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  };

  const unassigned = result.unassigned || [];
  const candidate = unassigned.find((r) => {
    const t = fmtTime(r.reservationTime);
    const destAddr = (r.dest && (r.dest.address || "")) || "";
    const originAddr = (r.origin && (r.origin.address || "")) || "";
    return (
      t === "22:45" &&
      destAddr.includes("楊梅") &&
      originAddr.includes("桃園機場")
    );
  });

  const shift = (driverShifts || []).find(
    (s) => String(s.driverId) === driverId
  );

  const summary = {
    date: dateStr,
    driver: {
      id: driverId,
      name: driver.username || driver.name,
      shift: shift ? shift.shift : null,
    },
    lastAssignedReservation: null,
    candidateUnassigned: null,
  };

  if (
    scheduleForDriver &&
    Array.isArray(scheduleForDriver.reservations) &&
    scheduleForDriver.reservations.length > 0
  ) {
    const sorted = scheduleForDriver.reservations
      .slice()
      .sort((a, b) => (a.reservationTime || 0) - (b.reservationTime || 0));
    const lastRes = sorted[sorted.length - 1];
    summary.lastAssignedReservation = {
      id: lastRes.id,
      time: fmtTime(lastRes.reservationTime),
      origin: lastRes.origin && lastRes.origin.address,
      dest: lastRes.dest && lastRes.dest.address,
    };
  }

  if (candidate) {
    summary.candidateUnassigned = {
      id: candidate.id,
      time: fmtTime(candidate.reservationTime),
      origin: candidate.origin && candidate.origin.address,
      dest: candidate.dest && candidate.dest.address,
    };
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("ERR", err && err.message ? err.message : err);
  process.exit(1);
});

