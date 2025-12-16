const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult } = require("express-validator");
const db = require("../config/database");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

// Register
router.post(
  "/register",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email")
      .isEmail()
      .normalizeEmail()
      .withMessage("Valid email required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { name, email, password, phone } = req.body;

      // Check if email exists
      const [existing] = await db.execute(
        "SELECT id FROM users WHERE email = ?",
        [email]
      );
      if (existing.length > 0) {
        return res
          .status(409)
          .json({ success: false, message: "Email already registered" });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);
      const userUuid = uuidv4();

      // Create user
      const [result] = await db.execute(
        "INSERT INTO users (uuid, name, email, password_hash, phone) VALUES (?, ?, ?, ?, ?)",
        [userUuid, name, email, passwordHash, phone || null]
      );

      // Generate token
      const token = jwt.sign(
        { userId: result.insertId, uuid: userUuid },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
      );

      res.status(201).json({
        success: true,
        message: "Registration successful",
        data: {
          token,
          user: { uuid: userUuid, name, email },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Login
router.post(
  "/login",
  [body("email").isEmail().normalizeEmail(), body("password").notEmpty()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { email, password } = req.body;
      const deviceId = req.headers["x-device-id"];
      const deviceInfo = req.body.deviceInfo;

      // Find user
      const [users] = await db.execute(
        "SELECT * FROM users WHERE email = ? AND is_active = true",
        [email]
      );

      if (users.length === 0) {
        return res
          .status(401)
          .json({ success: false, message: "Invalid credentials" });
      }

      const user = users[0];

      // Verify password
      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        return res
          .status(401)
          .json({ success: false, message: "Invalid credentials" });
      }

      // Update or insert device info
      if (deviceId && deviceInfo) {
        await db.execute(
          `
        INSERT INTO devices (user_id, device_id, device_name, device_model, os_version, app_version, last_active_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          device_name = VALUES(device_name),
          device_model = VALUES(device_model),
          os_version = VALUES(os_version),
          app_version = VALUES(app_version),
          last_active_at = NOW(),
          is_active = true
      `,
          [
            user.id,
            deviceId,
            deviceInfo.deviceName || null,
            deviceInfo.deviceModel || null,
            deviceInfo.osVersion || null,
            deviceInfo.appVersion || null,
          ]
        );
      }

      // Log activity
      await db.execute(
        `INSERT INTO user_activities (user_id, device_id, activity_type, ip_address) VALUES (?, ?, 'login', ?)`,
        [user.id, deviceId || null, req.ip]
      );

      // Generate token
      const token = jwt.sign(
        { userId: user.id, uuid: user.uuid },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
      );

      res.json({
        success: true,
        message: "Login successful",
        data: {
          token,
          user: {
            uuid: user.uuid,
            name: user.name,
            email: user.email,
            role: user.role,
            profileImage: user.profile_image,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Get Profile
router.get("/profile", authenticateToken, async (req, res) => {
  res.json({
    success: true,
    data: {
      uuid: req.user.uuid,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
    },
  });
});

// Update Profile
router.put(
  "/profile",
  authenticateToken,
  [body("name").optional().trim().notEmpty()],
  async (req, res, next) => {
    try {
      const { name, phone } = req.body;

      await db.execute(
        "UPDATE users SET name = COALESCE(?, name), phone = COALESCE(?, phone) WHERE id = ?",
        [name, phone, req.user.id]
      );

      res.json({ success: true, message: "Profile updated" });
    } catch (error) {
      next(error);
    }
  }
);

// Refresh Token
router.post("/refresh-token", authenticateToken, (req, res) => {
  const token = jwt.sign(
    { userId: req.user.id, uuid: req.user.uuid },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );

  res.json({ success: true, data: { token } });
});

// Logout
router.post("/logout", authenticateToken, async (req, res, next) => {
  try {
    // Log activity
    await db.execute(
      `INSERT INTO user_activities (user_id, device_id, activity_type, ip_address) VALUES (?, ?, 'logout', ?)`,
      [req.user.id, req.deviceId, req.ip]
    );

    // Deactivate device
    if (req.deviceId) {
      await db.execute(
        "UPDATE devices SET is_active = false WHERE user_id = ? AND device_id = ?",
        [req.user.id, req.deviceId]
      );
    }

    res.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
