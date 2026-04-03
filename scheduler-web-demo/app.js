const path = require("path");
const express = require("express");
const session = require("express-session");

// 載入 .env（開發環境用，Cloud Run 使用環境變數注入）
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const scheduleRoutes = require("./routes/schedule");
const settingsRoutes = require("./routes/settings");

const app = express();
const PORT = process.env.PORT || 4000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session
app.use(
  session({
    secret: process.env.SESSION_SECRET || "zemo-scheduler-secret-2026",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }, // 24 小時
  })
);

// ── 登入 ──
const AUTH_EMAIL = process.env.AUTH_EMAIL;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect("/login");
}

app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (email === AUTH_EMAIL && password === AUTH_PASSWORD) {
    req.session.authenticated = true;
    return res.redirect("/");
  }
  res.render("login", { error: "帳號或密碼錯誤" });
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

// 所有路由需要登入
app.use(requireAuth);

app.use("/schedule", scheduleRoutes);
app.use("/settings", settingsRoutes);

app.get("/", (req, res) => {
  res.redirect("/schedule");
});

app.listen(PORT, () => {
  console.log(`Scheduler web demo listening on http://localhost:${PORT}`);
});
