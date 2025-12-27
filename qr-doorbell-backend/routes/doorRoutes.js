const express = require("express");
const router = express.Router();
const { db, messaging } = require("../firebase");
const { v4: uuidv4 } = require("uuid");
const generateQR = require("../utils/qrGenerator");
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

// Agora configuration
const AGORA_APP_ID = "e99f68decc74469e93db09796e5ccd8c";
const AGORA_APP_CERTIFICATE = "42c79730f2a04138a26c5a8339e005d8"; // Add your Agora app certificate

// ✅ Generate new QR code and store in RTDB
router.post("/generate", async (req, res) => {
  try {
    const doorID = uuidv4();
    const qrCode = await generateQR(doorID);

    await db.ref(`doors/${doorID}`).set({
      claimed: false,
      claimedBy: null,
      createdAt: new Date().toISOString()
    });

    res.json({ doorID, qrCode });
  } catch (error) {
    console.error("QR generation failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});


// ✅ Activate QR code for doorbell
router.post("/activate", async (req, res) => {
  try {
    const { doorID, ownerID, phoneNumber } = req.body;

    if (!doorID || !ownerID) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const snapshot = await db.ref(`doors/${doorID}`).once("value");
    
    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Door ID not found" });
    }

    const doorData = snapshot.val();
    
    if (doorData.claimed) {
      return res.status(400).json({ error: "Door already claimed" });
    }

    // Update door with owner information
    await db.ref(`doors/${doorID}`).update({
      claimed: true,
      claimedBy: ownerID,
      ownerPhone: phoneNumber||null,
      status: 'active',
      activatedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    });

    // Add to user's doorbells
    await db.ref(`users/${ownerID}/doorbells/${doorID}`).set({
      doorID: doorID,
      status: 'active',
      activatedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    });

    res.json({ 
      success: true, 
      message: "Doorbell activated successfully",
      doorID: doorID 
    });
  } catch (error) {
    console.error("QR activation failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});
// ✅ Register/Update FCM token for a user
router.post('/push/register', async (req, res) => {
  try {
    const { ownerID, token } = req.body;
    if (!ownerID || !token) return res.status(400).json({ error: 'Missing ownerID or token' });

    const ref = db.ref(`users/${ownerID}/fcmTokens`);
    const snap = await ref.once('value');
    const tokens = snap.exists() ? snap.val() : [];
    if (!tokens.includes(token)) tokens.push(token);
    await ref.set(tokens);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to register token' });
  }
});

// ✅ Unregister FCM token for a user (logout)
router.post('/push/unregister', async (req, res) => {
  try {
    const { ownerID, token } = req.body;
    if (!ownerID || !token) return res.status(400).json({ error: 'Missing ownerID or token' });

    const ref = db.ref(`users/${ownerID}/fcmTokens`);
    const snap = await ref.once('value');
    if (snap.exists()) {
      const tokens = snap.val();
      // Handle both array and single token cases
      let updatedTokens;
      if (Array.isArray(tokens)) {
        updatedTokens = tokens.filter(t => t !== token);
      } else if (tokens === token) {
        updatedTokens = [];
      } else {
        // Single token that doesn't match - keep it
        updatedTokens = [tokens];
      }
      // Remove the node if no tokens remain, otherwise update with filtered array
      if (updatedTokens.length === 0) {
        await ref.remove();
      } else {
        await ref.set(updatedTokens);
      }
    }
    res.json({ success: true });
  } catch (e) {
    console.error('FCM unregister failed:', e);
    res.status(500).json({ error: 'Failed to unregister token' });
  }
});

// ✅ Device session management for one-user-per-device
router.post('/device/bind', async (req, res) => {
  try {
    const { userID, deviceID } = req.body;
    if (!userID || !deviceID) return res.status(400).json({ error: 'Missing userID or deviceID' });

    // Check if user is already logged in on another device
    const userSessionRef = db.ref(`userSessions/${userID}`);
    const userSessionSnap = await userSessionRef.once('value');
    
    if (userSessionSnap.exists()) {
      const existingSession = userSessionSnap.val();
      if (existingSession.deviceID !== deviceID) {
        return res.status(409).json({ 
          error: 'User already logged in on another device',
          existingDeviceID: existingSession.deviceID,
          loginTime: existingSession.loginTime
        });
      }
    }

    // Check if device is already bound to another user
    const deviceSessionRef = db.ref(`deviceSessions/${deviceID}`);
    const deviceSessionSnap = await deviceSessionRef.once('value');
    
    if (deviceSessionSnap.exists()) {
      const existingDeviceSession = deviceSessionSnap.val();
      if (existingDeviceSession.userID !== userID) {
        return res.status(409).json({ 
          error: 'Device already bound to another user',
          existingUserID: existingDeviceSession.userID,
          loginTime: existingDeviceSession.loginTime
        });
      }
    }

    // Create/update session bindings
    const sessionData = {
      userID: userID,
      deviceID: deviceID,
      loginTime: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    };

    await userSessionRef.set(sessionData);
    await deviceSessionRef.set(sessionData);
    await db.ref(`users/${userID}/presence`).set({
      online: true,
      deviceID: deviceID,
      lastSeen: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    res.json({ success: true, message: 'Device bound successfully' });
  } catch (e) {
    console.error('Device binding failed:', e);
    res.status(500).json({ error: 'Failed to bind device' });
  }
});

// ✅ Check device session status
router.get('/device/status', async (req, res) => {
  try {
    const { userID, deviceID } = req.query;
    if (!userID || !deviceID) return res.status(400).json({ error: 'Missing userID or deviceID' });

    const userSessionRef = db.ref(`userSessions/${userID}`);
    const userSessionSnap = await userSessionRef.once('value');
    
    if (!userSessionSnap.exists()) {
      return res.json({ isLoggedIn: false, message: 'No active session' });
    }

    const session = userSessionSnap.val();
    if (session.deviceID !== deviceID) {
      return res.json({ 
        isLoggedIn: false, 
        message: 'User logged in on different device',
        currentDeviceID: session.deviceID,
        loginTime: session.loginTime
      });
    }

    res.json({ 
      isLoggedIn: true, 
      loginTime: session.loginTime,
      lastActivity: session.lastActivity
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to check device status' });
  }
});

// ✅ Unbind device (logout)
router.post('/device/unbind', async (req, res) => {
  try {
    const { userID, deviceID } = req.body;
    if (!userID || !deviceID) return res.status(400).json({ error: 'Missing userID or deviceID' });

    // Remove user session
    await db.ref(`userSessions/${userID}`).remove();
    
    // Remove device session
    await db.ref(`deviceSessions/${deviceID}`).remove();
    
    await db.ref(`users/${userID}/presence`).set({
      online: false,
      deviceID: null,
      lastSeen: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    res.json({ success: true, message: 'Device unbound successfully' });
  } catch (e) {
    console.error('Device unbinding failed:', e);
    res.status(500).json({ error: 'Failed to unbind device' });
  }
});


// ✅ Get incoming calls for owner  
router.get("/call/incoming", async (req, res) => {
  try {
    const { ownerID } = req.query;
    if (!ownerID) return res.status(400).json({ error: "Missing ownerID" });

    const snapshot = await db.ref("calls").orderByChild("ownerID").equalTo(ownerID).once("value");
    const calls = [];
    snapshot.forEach(child => {
      const call = child.val();
      if (call.status === "ringing") {
        calls.push({ ...call, callID: child.key });
      }
    });
    res.json({ calls });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Get user's doorbells
router.get("/my-doorbells", async (req, res) => {
  try {
    const ownerID = req.query.ownerID || 'user_123'; // TODO: Get from auth
    
    const snapshot = await db.ref(`users/${ownerID}/doorbells`).once("value");
    
    if (!snapshot.exists()) {
      return res.json({ doorbells: [] });
    }

    const doorbells = [];
    snapshot.forEach((childSnapshot) => {
      doorbells.push(childSnapshot.val());
    });

    res.json({ doorbells });
  } catch (error) {
    console.error("Failed to get doorbells:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Deactivate doorbell
router.post("/deactivate", async (req, res) => {
  try {
    const { doorID } = req.body;
    const ownerID = req.body.ownerID || 'user_123'; // TODO: Get from auth

    await db.ref(`doors/${doorID}/status`).set('inactive');
    await db.ref(`users/${ownerID}/doorbells/${doorID}/status`).set('inactive');

    res.json({ success: true, message: "Doorbell deactivated" });
  } catch (error) {
    console.error("Deactivation failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Delete doorbell
router.delete("/:doorID", async (req, res) => {
  try {
    const { doorID } = req.params;
    // Try to get ownerID from body or query
    const ownerID = req.body.ownerID || req.query.ownerID;

    await db.ref(`doors/${doorID}`).remove();
    await db.ref(`users/${ownerID}/doorbells/${doorID}`).remove();

    res.json({ success: true, message: "Doorbell deleted" });
  } catch (error) {
    console.error("Deletion failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Initiate video call (visitor endpoint)
router.post("/call/:doorID", async (req, res) => {
  try {
    const { doorID } = req.params;
    const { visitorName } = req.body;

    const snapshot = await db.ref(`doors/${doorID}`).once("value");
    
    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Door ID not found" });
    }

    const doorData = snapshot.val();
    
    if (!doorData.claimed || doorData.status !== 'active') {
      return res.status(400).json({ error: "Doorbell not active" });
    }
    if (!doorData.claimedBy) {
      return res.status(400).json({ error: "Doorbell owner not set" });
    }

    const ownerID = doorData.claimedBy;
    const ownerSessionSnap = await db.ref(`userSessions/${ownerID}`).once('value');
    if (!ownerSessionSnap.exists()) {
      return res.status(409).json({ error: "Owner is offline" });
    }
    const tokensSnap = await db.ref(`users/${ownerID}/fcmTokens`).once('value');
    if (!tokensSnap.exists()) {
      return res.status(409).json({ error: "Owner has no registered devices" });
    }
    const rawTokens = tokensSnap.val();
    const tokenList = Array.isArray(rawTokens)
      ? rawTokens.filter(Boolean)
      : (rawTokens ? [rawTokens] : []);
    if (tokenList.length === 0) {
      return res.status(409).json({ error: "Owner has no registered devices" });
    }

    // Generate unique channel name for this call
    const channelName = `doorbell_${doorID}_${Date.now()}`;
    
    // Generate Agora token (you'll need to implement this)
    const token = generateAgoraToken(channelName);

    // Store call information
    const callID = uuidv4();
    const createdAt = new Date().toISOString();
    await db.ref(`calls/${callID}`).set({
      doorID: doorID,
      channelName: channelName,
      visitorName: visitorName,
      status: 'ringing',
      token: token,
      createdAt: createdAt,
      ownerPhone: doorData.ownerPhone || null,
      ownerID: ownerID || null
    });

    // Create initial call log entry in user's call logs
    await db.ref(`users/${ownerID}/callLogs/${callID}`).set({
      callID: callID,
      visitorName: visitorName || 'Visitor',
      status: 'ringing',
      doorID: doorID,
      channelName: channelName,
      createdAt: createdAt,
      updatedAt: createdAt
    });

    // Update doorbell last activity
    await db.ref(`doors/${doorID}/lastActivity`).set(new Date().toISOString());
    await db.ref(`users/${doorData.claimedBy}/doorbells/${doorID}/lastActivity`).set(new Date().toISOString());

    // Notify owner via FCM
    try {
      const message = {
        notification: { title: 'Incoming Call', body: `Visitor: ${visitorName || ''}` },
        data: {
          type: 'incoming_call',
          callID: callID,
          channelName: channelName,
          token: token,
          visitorName: visitorName || 'Visitor'
        },
        android: { priority: 'high' },
        apns: { headers: { 'apns-priority': '10' } },
        tokens: tokenList
      };
      await messaging.sendEachForMulticast(message);
    } catch (err) {
      console.error('FCM send failed', err);
    }

    res.json({
      success: true,
      callID: callID,
      channelName: channelName,
      agoraAppId: AGORA_APP_ID,
      token: token
    });
  } catch (error) {
    console.error("Call initiation failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Get call status
router.get("/call/:callID/status", async (req, res) => {
  try {
    const { callID } = req.params;
    
    const snapshot = await db.ref(`calls/${callID}`).once("value");
    
    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Call not found" });
    }

    res.json(snapshot.val());
  } catch (error) {
    console.error("Failed to get call status:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Accept call (owner endpoint)
router.post("/call/:callID/accept", async (req, res) => {
  try {
    const { callID } = req.params;
    
    // Get call data to find ownerID
    const callSnap = await db.ref(`calls/${callID}`).once('value');
    if (!callSnap.exists()) {
      return res.status(404).json({ error: "Call not found" });
    }
    const callData = callSnap.val();
    const ownerID = callData.ownerID;
    
    const updatedAt = new Date().toISOString();
    await db.ref(`calls/${callID}/status`).set('accepted');
    await db.ref(`calls/${callID}/acceptedAt`).set(updatedAt);
    
    // Update call log with approved status
    if (ownerID) {
      await db.ref(`users/${ownerID}/callLogs/${callID}`).update({
        status: 'approved',
        updatedAt: updatedAt,
        acceptedAt: updatedAt
      });
    }
    
    res.json({ success: true, message: "Call accepted" });
  } catch (error) {
    console.error("Call acceptance failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ End call
router.post("/call/:callID/end", async (req, res) => {
  try {
    const { callID } = req.params;
    
    // Get call data to find ownerID and determine status
    const callSnap = await db.ref(`calls/${callID}`).once('value');
    if (!callSnap.exists()) {
      return res.status(404).json({ error: "Call not found" });
    }
    const callData = callSnap.val();
    const ownerID = callData.ownerID;
    const currentStatus = callData.status;
    
    const endedAt = new Date().toISOString();
    await db.ref(`calls/${callID}/status`).set('ended');
    await db.ref(`calls/${callID}/endedAt`).set(endedAt);
    
    // Update call log - if call was ringing and now ended, mark as declined
    // If call was accepted and now ended, keep it as approved but mark ended
    if (ownerID) {
      let logStatus = 'declined'; // Default for declined calls
      if (currentStatus === 'accepted') {
        logStatus = 'approved'; // Keep as approved if it was already accepted
      }
      
      await db.ref(`users/${ownerID}/callLogs/${callID}`).update({
        status: logStatus,
        updatedAt: endedAt,
        endedAt: endedAt
      });
    }
    
    res.json({ success: true, message: "Call ended" });
  } catch (error) {
    console.error("Call ending failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Get call logs for owner with counts
router.get("/call/logs", async (req, res) => {
  try {
    const { ownerID, limit } = req.query;
    if (!ownerID) return res.status(400).json({ error: "Missing ownerID" });

    const limitNum = limit ? parseInt(limit, 10) : 50;
    const callLogsRef = db.ref(`users/${ownerID}/callLogs`);
    const snapshot = await callLogsRef.once('value');
    
    if (!snapshot.exists()) {
      return res.json({
        logs: [],
        counts: {
          approved: 0,
          declined: 0,
          total: 0
        }
      });
    }

    const logs = [];
    let approvedCount = 0;
    let declinedCount = 0;

    snapshot.forEach((child) => {
      const log = child.val();
      log.callID = child.key;
      
      // Count approved and declined
      if (log.status === 'approved') {
        approvedCount++;
      } else if (log.status === 'declined') {
        declinedCount++;
      }
      
      logs.push(log);
      return false; // Continue iteration
    });

    // Sort by createdAt descending (most recent first)
    logs.sort((a, b) => {
      const dateA = new Date(a.createdAt || 0);
      const dateB = new Date(b.createdAt || 0);
      return dateB.getTime() - dateA.getTime();
    });

    // Apply limit
    const limitedLogs = logs.slice(0, limitNum);

    res.json({
      logs: limitedLogs,
      counts: {
        approved: approvedCount,
        declined: declinedCount,
        total: logs.length
      }
    });
  } catch (error) {
    console.error("Failed to get call logs:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Get incoming calls for owner



// ✅ Get door status from RTDB
router.get("/:doorID", async (req, res) => {
  const { doorID } = req.params;
  const snapshot = await db.ref(`doors/${doorID}`).once("value");

  if (!snapshot.exists()) {
    return res.status(404).json({ message: "Invalid door ID" });
  }

  res.json(snapshot.val());
});

// ✅ Get token for a call
router.get("/call/:callID/token", async (req, res) => {
  try {
    const { callID } = req.params;
    const snapshot = await db.ref(`calls/${callID}`).once("value");
    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Call not found" });
    }
    const call = snapshot.val();
    if (!call.token) {
      return res.status(404).json({ error: "Token not found" });
    }
    res.json({ token: call.token });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// Helper function to generate Agora token
function generateAgoraToken(channelName) {
  const appID = "e99f68decc74469e93db09796e5ccd8c";
  const appCertificate = "42c79730f2a04138a26c5a8339e005d8";
  const uid = 0; // use 0 for dynamic UID
  const role = RtcRole.PUBLISHER;
  const expireTimeSeconds = 3600; // 1 hour
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpireTime = currentTimestamp + expireTimeSeconds;
  return RtcTokenBuilder.buildTokenWithUid(appID, appCertificate, channelName, uid, role, privilegeExpireTime);
}

// Scheduled cleanup for orphaned calls
setInterval(async () => {
  try {
    const now = Date.now();
    const tenMinutes = 5 * 60 * 1000;
    const snapshot = await db.ref('calls').once('value');
    snapshot.forEach(child => {
      const call = child.val();
      if ((call.status === 'ringing' || call.status === 'accepted') && call.createdAt) {
        const createdAt = new Date(call.createdAt).getTime();
        if (now - createdAt > tenMinutes) {
          db.ref(`calls/${child.key}/status`).set('ended');
          db.ref(`calls/${child.key}/endedAt`).set(new Date().toISOString());
          console.log(`Cleaned up orphaned call: ${child.key}`);
        }
      }
    });
  } catch (err) {
    console.error('Error during call cleanup:', err);
  }
}, 5 * 60 * 1000); // Run every 5 minutes

module.exports = router;
