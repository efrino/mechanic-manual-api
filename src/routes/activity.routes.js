const express = require("express");
const db = require("../config/database");

const router = express.Router();

// Log user activity (batch)
router.post("/log", async (req, res, next) => {
  try {
    const { activities } = req.body;

    if (!activities || !Array.isArray(activities) || activities.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Activities array required" });
    }

    const insertValues = activities.map((a) => [
      req.user.id,
      req.deviceId || a.deviceId || null,
      a.activityType,
      a.referenceId || null,
      a.referenceType || null,
      a.metadata ? JSON.stringify(a.metadata) : null,
      a.durationSeconds || null,
      req.ip,
      a.createdAt ? new Date(a.createdAt) : new Date(),
    ]);

    const placeholders = insertValues
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .join(", ");
    const flatValues = insertValues.flat();

    await db.execute(
      `
      INSERT INTO user_activities (user_id, device_id, activity_type, reference_id, reference_type, metadata, duration_seconds, ip_address, created_at)
      VALUES ${placeholders}
    `,
      flatValues
    );

    res.json({
      success: true,
      message: `${activities.length} activities logged`,
    });
  } catch (error) {
    next(error);
  }
});

// Log single activity
router.post("/single", async (req, res, next) => {
  try {
    const {
      activityType,
      referenceId,
      referenceType,
      metadata,
      durationSeconds,
    } = req.body;

    if (!activityType) {
      return res
        .status(400)
        .json({ success: false, message: "Activity type required" });
    }

    await db.execute(
      `
      INSERT INTO user_activities (user_id, device_id, activity_type, reference_id, reference_type, metadata, duration_seconds, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        req.user.id,
        req.deviceId,
        activityType,
        referenceId || null,
        referenceType || null,
        metadata ? JSON.stringify(metadata) : null,
        durationSeconds || null,
        req.ip,
      ]
    );

    res.json({ success: true, message: "Activity logged" });
  } catch (error) {
    next(error);
  }
});

// Update device info
router.post("/device", async (req, res, next) => {
  try {
    const {
      deviceId,
      deviceName,
      deviceModel,
      osVersion,
      appVersion,
      fcmToken,
    } = req.body;

    if (!deviceId) {
      return res
        .status(400)
        .json({ success: false, message: "Device ID required" });
    }

    await db.execute(
      `
      INSERT INTO devices (user_id, device_id, device_name, device_model, os_version, app_version, fcm_token, last_active_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        device_name = COALESCE(VALUES(device_name), device_name),
        device_model = COALESCE(VALUES(device_model), device_model),
        os_version = COALESCE(VALUES(os_version), os_version),
        app_version = COALESCE(VALUES(app_version), app_version),
        fcm_token = COALESCE(VALUES(fcm_token), fcm_token),
        last_active_at = NOW(),
        is_active = true
    `,
      [
        req.user.id,
        deviceId,
        deviceName || null,
        deviceModel || null,
        osVersion || null,
        appVersion || null,
        fcmToken || null,
      ]
    );

    res.json({ success: true, message: "Device info updated" });
  } catch (error) {
    next(error);
  }
});

// Get user's activity history (for admin or self)
router.get("/history", async (req, res, next) => {
  try {
    const { type, from, to, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let query = "SELECT * FROM user_activities WHERE user_id = ?";
    const params = [req.user.id];

    if (type) {
      query += " AND activity_type = ?";
      params.push(type);
    }

    if (from) {
      query += " AND created_at >= ?";
      params.push(new Date(from));
    }

    if (to) {
      query += " AND created_at <= ?";
      params.push(new Date(to));
    }

    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(parseInt(limit), parseInt(offset));

    const [activities] = await db.execute(query, params);

    res.json({
      success: true,
      data: activities,
    });
  } catch (error) {
    next(error);
  }
});

// Get user's devices
router.get("/devices", async (req, res, next) => {
  try {
    const [devices] = await db.execute(
      "SELECT * FROM devices WHERE user_id = ? ORDER BY last_active_at DESC",
      [req.user.id]
    );

    res.json({ success: true, data: devices });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
