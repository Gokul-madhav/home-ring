const express = require("express");
const router = express.Router();
const { db, messaging } = require("../firebase");
const { v4: uuidv4 } = require("uuid");
const generateQR = require("../utils/qrGenerator");
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

const MAX_FAMILY_MEMBERS = 4;

// ---- RBAC helpers (family-group based) ----
const PRIORITY_RANK = { low: 0, normal: 1, high: 2 };

function normalizePriority(input) {
  const p = (input ?? '').toString().trim().toLowerCase();
  if (p === 'low' || p === 'normal' || p === 'high') return p;
  return 'normal';
}

function androidPriorityFromCallPriority(callPriority) {
  const p = normalizePriority(callPriority);
  return p === 'high' ? 'high' : 'normal';
}

async function getUserFamilyGroupId(userId) {
  if (!userId) return null;
  const snap = await db.ref(`users/${userId}/familyGroupId`).once('value');
  if (!snap.exists()) return null;
  const val = snap.val();
  return val ? val.toString() : null;
}

async function getUserRoleInFamilyGroup(familyGroupId, userId) {
  if (!familyGroupId || !userId) return null;
  const snap = await db
    .ref(`familyGroups/${familyGroupId}/members/${userId}/role`)
    .once('value');
  if (!snap.exists()) return null;
  const val = snap.val();
  return val ? val.toString() : null;
}

async function isUserMemberOfFamilyGroup(familyGroupId, userId) {
  const role = await getUserRoleInFamilyGroup(familyGroupId, userId);
  return role === 'admin' || role === 'member';
}

async function getFamilyMemberIds(familyGroupId) {
  if (!familyGroupId) return [];
  const snap = await db.ref(`familyGroups/${familyGroupId}/members`).once('value');
  if (!snap.exists()) return [];
  const members = snap.val();
  if (!members || typeof members !== 'object') return [];
  return Object.keys(members);
}

async function getUserFcmTokens(userId) {
  if (!userId) return [];
  const tokensSnap = await db.ref(`users/${userId}/fcmTokens`).once('value');
  if (!tokensSnap.exists()) return [];

  const raw = tokensSnap.val();
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean).map((t) => t.toString());
  return [raw.toString()].filter(Boolean);
}

async function getUserIsOnline(userId) {
  if (!userId) return false;
  const sessionSnap = await db.ref(`userSessions/${userId}`).once('value');
  return sessionSnap.exists();
}

async function getOnlineFamilyFcmTokens(familyGroupId) {
  const memberIds = await getFamilyMemberIds(familyGroupId);
  const tokens = [];

  for (const memberId of memberIds) {
    if (!(await getUserIsOnline(memberId))) continue;
    const memberTokens = await getUserFcmTokens(memberId);
    for (const t of memberTokens) {
      if (t && !tokens.includes(t)) tokens.push(t);
    }
  }

  return tokens;
}

async function getCallDataOrThrow(callID) {
  const callSnap = await db.ref(`calls/${callID}`).once('value');
  if (!callSnap.exists()) {
    const err = new Error('Call not found');
    err.statusCode = 404;
    throw err;
  }
  return callSnap.val();
}

/** Sequential family routing: ring each owner slot ~12s before advancing */
const RING_TIMEOUT_MS = 12000;

async function getUserAvailabilityStatus(userId) {
  if (!userId) return 'offline';
  const sessionOk = await getUserIsOnline(userId);
  const presSnap = await db.ref(`users/${userId}/presence`).once('value');
  if (!presSnap.exists()) {
    return sessionOk ? 'online' : 'offline';
  }
  const p = presSnap.val();
  const st = (p.availabilityStatus || '').toString().toLowerCase();
  if (st === 'busy') return 'busy';
  if (st === 'offline') return 'offline';
  if (p.online === false) return 'offline';
  return sessionOk ? 'online' : 'offline';
}

async function isUserRoutable(userId) {
  const st = await getUserAvailabilityStatus(userId);
  return st === 'online';
}

async function getRoutingMemberQueue(familyGroupId) {
  if (!familyGroupId) return [];
  const groupSnap = await db.ref(`familyGroups/${familyGroupId}`).once('value');
  if (!groupSnap.exists()) return [];
  const group = groupSnap.val();
  const members = group.members || {};
  const memberKeys = new Set(Object.keys(members));
  let order = [];
  if (Array.isArray(group.callRoutingOrder)) {
    order = group.callRoutingOrder.map((x) => x.toString()).filter((id) => memberKeys.has(id));
  }
  for (const id of memberKeys) {
    if (!order.includes(id)) order.push(id);
  }
  return order;
}

async function findNextRoutableIndex(queue, fromIndex) {
  for (let i = Math.max(0, fromIndex); i < queue.length; i++) {
    if (await isUserRoutable(queue[i])) return i;
  }
  return -1;
}

function ownerLabelFromIndex(i) {
  return `Owner ${i + 1}`;
}

async function sendIncomingFcmToUsers(userIds, payload, androidPri) {
  const tokens = [];
  for (const uid of userIds) {
    const ts = await getUserFcmTokens(uid);
    for (const t of ts) {
      if (t && !tokens.includes(t)) tokens.push(t);
    }
  }
  if (!tokens.length) return;
  const message = {
    notification: {
      title: 'Incoming Call',
      body: `Visitor: ${payload.visitorName || ''}`,
    },
    data: payload,
    android: { priority: androidPri },
    apns: { headers: { 'apns-priority': '10' } },
    tokens,
  };
  try {
    await messaging.sendEachForMulticast(message);
  } catch (err) {
    console.error('FCM send failed', err);
  }
}

/** Data-only FCM: dismiss CallKit / incoming UI when sequential ring moves on or ends. */
async function sendRingCancelledFcmToUsers(userIds, { callID, reason }) {
  const tokens = [];
  for (const uid of userIds) {
    const ts = await getUserFcmTokens(uid);
    for (const t of ts) {
      if (t && !tokens.includes(t)) tokens.push(t);
    }
  }
  if (!tokens.length) return;
  const cid = String(callID);
  const r = String(reason || 'routing_advanced');
  const message = {
    data: {
      type: 'ring_cancelled',
      event: 'ring_cancelled',
      callID: cid,
      reason: r,
    },
    android: { priority: 'high' },
    apns: {
      headers: { 'apns-priority': '5' },
      payload: { aps: { 'content-available': 1 } },
    },
    tokens,
  };
  try {
    await messaging.sendEachForMulticast(message);
  } catch (err) {
    console.error('FCM ring_cancelled send failed', err);
  }
}

async function finalizeCallNoAnswer(callID) {
  const snap = await db.ref(`calls/${callID}`).once('value');
  const callVal = snap.exists() ? snap.val() : {};
  const prevTarget = callVal.currentTargetUserId
    ? String(callVal.currentTargetUserId)
    : null;

  const endedAt = new Date().toISOString();
  await db.ref(`calls/${callID}`).update({
    status: 'ended',
    endedAt,
    routingPhase: 'no_answer',
    visitorStatusMessage: 'All members are unavailable',
    endedBy: 'system',
    updatedAt: endedAt,
  });

  if (prevTarget) {
    await sendRingCancelledFcmToUsers([prevTarget], { callID, reason: 'no_answer' });
  }
}

async function advanceSequentialRing(callID, force = false) {
  const ref = db.ref(`calls/${callID}`);
  const snap = await ref.once('value');
  if (!snap.exists()) return;
  const c = snap.val();
  if (c.status !== 'ringing' || !c.sequentialRouting) return;

  const deadline = c.ringDeadlineAt ? new Date(c.ringDeadlineAt).getTime() : 0;
  if (!force && Date.now() < deadline) return;

  const queue = Array.isArray(c.routingQueue) ? c.routingQueue.map(String) : [];
  const prevIdx = Number(c.routingIndex);
  const prevTargetUserId = c.currentTargetUserId ? String(c.currentTargetUserId) : null;
  const nextIdx = await findNextRoutableIndex(queue, prevIdx + 1);

  if (nextIdx < 0) {
    await finalizeCallNoAnswer(callID);
    return;
  }

  const nextUid = queue[nextIdx];
  const label = ownerLabelFromIndex(nextIdx);
  const ringDeadlineAt = new Date(Date.now() + RING_TIMEOUT_MS).toISOString();
  const pri = normalizePriority(c.priority);

  await ref.update({
    routingIndex: nextIdx,
    currentTargetUserId: nextUid,
    ownerID: nextUid,
    currentOwnerLabel: label,
    ringDeadlineAt,
    visitorStatusMessage: `Calling ${label}...`,
    updatedAt: new Date().toISOString(),
  });

  await sendIncomingFcmToUsers([nextUid], {
    type: 'incoming_call',
    callID,
    channelName: c.channelName,
    token: c.token,
    visitorName: c.visitorName || 'Visitor',
    priority: pri,
    sequentialRouting: '1',
    currentOwnerLabel: label,
    routingIndex: String(nextIdx),
  }, androidPriorityFromCallPriority(pri));

  if (prevTargetUserId && prevTargetUserId !== String(nextUid)) {
    await sendRingCancelledFcmToUsers([prevTargetUserId], { callID, reason: 'routing_advanced' });
  }
}

async function clearBusyForUser(userId) {
  if (!userId) return;
  await db.ref(`users/${userId}/presence`).update({
    availabilityStatus: 'online',
    updatedAt: new Date().toISOString(),
  });
  await db.ref(`users/${userId}/presence/busyCallId`).remove();
}

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
      availabilityStatus: 'online',
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

// ✅ Take over session (logs out old device)
router.post('/device/takeover', async (req, res) => {
  try {
    const { userID, deviceID } = req.body;
    if (!userID || !deviceID) {
      return res.status(400).json({ error: 'Missing userID or deviceID' });
    }

    // New device must not already be bound to another user
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

    const userSessionRef = db.ref(`userSessions/${userID}`);
    const userSessionSnap = await userSessionRef.once('value');
    const oldDeviceID = userSessionSnap.exists()
      ? (userSessionSnap.val().deviceID || null)
      : null;

    // Remove old device binding (if different)
    if (oldDeviceID && oldDeviceID !== deviceID) {
      await db.ref(`deviceSessions/${oldDeviceID}`).remove();
    }

    const nowIso = new Date().toISOString();
    const sessionData = {
      userID: userID,
      deviceID: deviceID,
      loginTime: userSessionSnap.exists()
        ? (userSessionSnap.val().loginTime || nowIso)
        : nowIso,
      lastActivity: nowIso,
      takeoverAt: nowIso,
      previousDeviceID: oldDeviceID && oldDeviceID !== deviceID ? oldDeviceID : null
    };

    await userSessionRef.set(sessionData);
    await deviceSessionRef.set(sessionData);
    await db.ref(`users/${userID}/presence`).set({
      online: true,
      availabilityStatus: 'online',
      deviceID: deviceID,
      lastSeen: nowIso,
      updatedAt: nowIso
    });

    res.json({
      success: true,
      message: 'Session taken over successfully',
      oldDeviceID: oldDeviceID
    });
  } catch (e) {
    console.error('Session takeover failed:', e);
    res.status(500).json({ error: 'Failed to take over session' });
  }
});

// ✅ Family Group: Get my family group (by user)
router.get('/family/my', async (req, res) => {
  try {
    const { userID } = req.query;
    if (!userID) return res.status(400).json({ error: 'Missing userID' });

    const groupIdSnap = await db.ref(`users/${userID}/familyGroupId`).once('value');
    if (!groupIdSnap.exists() || !groupIdSnap.val()) {
      return res.json({ hasGroup: false, familyGroup: null });
    }
    const familyGroupId = groupIdSnap.val();
    const groupSnap = await db.ref(`familyGroups/${familyGroupId}`).once('value');
    if (!groupSnap.exists()) {
      return res.json({ hasGroup: false, familyGroup: null });
    }
    return res.json({ hasGroup: true, familyGroup: groupSnap.val() });
  } catch (e) {
    console.error('Failed to get my family group:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ Family Group: Create (creator becomes Primary Owner/Admin)
router.post('/family/create', async (req, res) => {
  try {
    const { adminUserId, name, deviceId } = req.body;
    if (!adminUserId) return res.status(400).json({ error: 'Missing adminUserId' });

    const existing = await db.ref(`users/${adminUserId}/familyGroupId`).once('value');
    if (existing.exists() && existing.val()) {
      return res.status(409).json({ error: 'User already belongs to a family group', familyGroupId: existing.val() });
    }

    const familyGroupId = uuidv4();
    const nowIso = new Date().toISOString();
    const groupData = {
      familyGroupId,
      adminUserId,
      callRoutingOrder: [adminUserId],
      members: {
        [adminUserId]: {
          userId: adminUserId,
          name: name ? String(name).trim() : null,
          deviceId: deviceId ? String(deviceId).trim() : null,
          role: 'admin',
          joinedAt: nowIso
        }
      },
      invites: {},
      createdAt: nowIso,
      updatedAt: nowIso
    };

    await db.ref(`familyGroups/${familyGroupId}`).set(groupData);
    await db.ref(`users/${adminUserId}/familyGroupId`).set(familyGroupId);

    res.json({ success: true, familyGroupId, familyGroup: groupData });
  } catch (e) {
    console.error('Failed to create family group:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ Family Group: Invite by email (creates a pending invite record)
router.post('/family/invite/email', async (req, res) => {
  try {
    const { familyGroupId, adminUserId, email } = req.body;
    if (!familyGroupId || !adminUserId || !email) {
      return res.status(400).json({ error: 'Missing familyGroupId, adminUserId, or email' });
    }

    const groupRef = db.ref(`familyGroups/${familyGroupId}`);
    const groupSnap = await groupRef.once('value');
    if (!groupSnap.exists()) return res.status(404).json({ error: 'Family group not found' });
    const group = groupSnap.val();
    if (group.adminUserId !== adminUserId) return res.status(403).json({ error: 'Only admin can invite' });

    const members = group.members || {};
    const memberCount = Object.keys(members).length;
    if (memberCount >= MAX_FAMILY_MEMBERS) {
      return res.status(409).json({ error: `Family group is full (max ${MAX_FAMILY_MEMBERS})` });
    }

    const inviteId = uuidv4();
    const nowIso = new Date().toISOString();
    const invite = {
      inviteId,
      email: String(email).trim().toLowerCase(),
      status: 'pending',
      createdAt: nowIso
    };
    await db.ref(`familyGroups/${familyGroupId}/invites/${inviteId}`).set(invite);
    await groupRef.child('updatedAt').set(nowIso);

    // NOTE: email sending is not implemented here; client can share link/code.
    res.json({ success: true, invite });
  } catch (e) {
    console.error('Failed to create email invite:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ Family Group: Join via invite link/code (familyGroupId)
router.post('/family/join', async (req, res) => {
  try {
    const { familyGroupId, userId, name, deviceId } = req.body;
    if (!familyGroupId || !userId) {
      return res.status(400).json({ error: 'Missing familyGroupId or userId' });
    }

    const userGroupSnap = await db.ref(`users/${userId}/familyGroupId`).once('value');
    if (userGroupSnap.exists() && userGroupSnap.val()) {
      return res.status(409).json({ error: 'User already belongs to a family group', familyGroupId: userGroupSnap.val() });
    }

    const groupRef = db.ref(`familyGroups/${familyGroupId}`);
    const groupSnap = await groupRef.once('value');
    if (!groupSnap.exists()) return res.status(404).json({ error: 'Family group not found' });
    const group = groupSnap.val();

    const members = group.members || {};
    const memberCount = Object.keys(members).length;
    if (memberCount >= MAX_FAMILY_MEMBERS) {
      return res.status(409).json({ error: `Family group is full (max ${MAX_FAMILY_MEMBERS})` });
    }
    if (members[userId]) {
      return res.json({ success: true, message: 'Already a member', familyGroup: group });
    }

    const nowIso = new Date().toISOString();
    await db.ref(`familyGroups/${familyGroupId}/members/${userId}`).set({
      userId,
      name: name ? String(name).trim() : null,
      deviceId: deviceId ? String(deviceId).trim() : null,
      role: 'member',
      joinedAt: nowIso
    });
    await db.ref(`users/${userId}/familyGroupId`).set(familyGroupId);
    await groupRef.child('updatedAt').set(nowIso);

    const prevOrderSnap = await groupRef.child('callRoutingOrder').once('value');
    let order = prevOrderSnap.exists() && Array.isArray(prevOrderSnap.val())
      ? [...prevOrderSnap.val()].map(String)
      : Object.keys(members);
    if (!order.includes(String(userId))) order.push(String(userId));
    await groupRef.child('callRoutingOrder').set(order);

    const updatedSnap = await groupRef.once('value');
    res.json({ success: true, familyGroup: updatedSnap.val() });
  } catch (e) {
    console.error('Failed to join family group:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ Family Group: Admin sets call routing order (Owner 1 → Owner 4)
router.post('/family/routing/order', async (req, res) => {
  try {
    const { familyGroupId, adminUserId, orderedUserIds } = req.body;
    if (!familyGroupId || !adminUserId || !Array.isArray(orderedUserIds)) {
      return res.status(400).json({ error: 'Missing familyGroupId, adminUserId, or orderedUserIds' });
    }

    const groupRef = db.ref(`familyGroups/${familyGroupId}`);
    const groupSnap = await groupRef.once('value');
    if (!groupSnap.exists()) return res.status(404).json({ error: 'Family group not found' });
    const group = groupSnap.val();
    if (group.adminUserId !== adminUserId) {
      return res.status(403).json({ error: 'Only admin can change routing order' });
    }

    const members = group.members || {};
    const memberKeys = new Set(Object.keys(members));
    const next = orderedUserIds.map((x) => String(x).trim()).filter((id) => memberKeys.has(id));
    const seen = new Set();
    const unique = [];
    for (const id of next) {
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(id);
      }
    }
    if (unique.length > MAX_FAMILY_MEMBERS) {
      return res.status(400).json({ error: `Too many slots (max ${MAX_FAMILY_MEMBERS})` });
    }

    await groupRef.child('callRoutingOrder').set(unique);
    await groupRef.child('updatedAt').set(new Date().toISOString());
    const updatedSnap = await groupRef.once('value');
    res.json({ success: true, familyGroup: updatedSnap.val() });
  } catch (e) {
    console.error('Failed to save routing order:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ Family Group: Remove member (admin only)
router.post('/family/remove', async (req, res) => {
  try {
    const { familyGroupId, adminUserId, targetUserId } = req.body;
    if (!familyGroupId || !adminUserId || !targetUserId) {
      return res.status(400).json({ error: 'Missing familyGroupId, adminUserId, or targetUserId' });
    }

    const groupRef = db.ref(`familyGroups/${familyGroupId}`);
    const groupSnap = await groupRef.once('value');
    if (!groupSnap.exists()) return res.status(404).json({ error: 'Family group not found' });
    const group = groupSnap.val();

    if (group.adminUserId !== adminUserId) {
      return res.status(403).json({ error: 'Only admin can remove members' });
    }
    if (String(targetUserId) === String(group.adminUserId)) {
      return res.status(409).json({ error: 'Cannot remove admin' });
    }

    const memberSnap = await db.ref(`familyGroups/${familyGroupId}/members/${targetUserId}`).once('value');
    if (!memberSnap.exists()) {
      return res.status(404).json({ error: 'Member not found' });
    }

    await db.ref(`familyGroups/${familyGroupId}/members/${targetUserId}`).remove();
    await db.ref(`users/${targetUserId}/familyGroupId`).remove();

    const ordSnap = await groupRef.child('callRoutingOrder').once('value');
    if (ordSnap.exists() && Array.isArray(ordSnap.val())) {
      const filtered = ordSnap.val().map(String).filter((id) => id !== String(targetUserId));
      await groupRef.child('callRoutingOrder').set(filtered);
    }

    await groupRef.child('updatedAt').set(new Date().toISOString());

    res.json({ success: true });
  } catch (e) {
    console.error('Failed to remove member:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ Family Group: Leave (non-admin only)
router.post('/family/leave', async (req, res) => {
  try {
    const { familyGroupId, userId } = req.body;
    if (!familyGroupId || !userId) return res.status(400).json({ error: 'Missing familyGroupId or userId' });

    const groupRef = db.ref(`familyGroups/${familyGroupId}`);
    const groupSnap = await groupRef.once('value');
    if (!groupSnap.exists()) return res.status(404).json({ error: 'Family group not found' });
    const group = groupSnap.val();
    if (group.adminUserId === userId) {
      return res.status(409).json({ error: 'Admin cannot leave the family group' });
    }

    await db.ref(`familyGroups/${familyGroupId}/members/${userId}`).remove();
    await db.ref(`users/${userId}/familyGroupId`).remove();

    const ordSnap = await groupRef.child('callRoutingOrder').once('value');
    if (ordSnap.exists() && Array.isArray(ordSnap.val())) {
      const filtered = ordSnap.val().map(String).filter((id) => id !== String(userId));
      await groupRef.child('callRoutingOrder').set(filtered);
    }

    await groupRef.child('updatedAt').set(new Date().toISOString());

    res.json({ success: true });
  } catch (e) {
    console.error('Failed to leave family group:', e);
    res.status(500).json({ error: 'Server error' });
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

    const nowIso = new Date().toISOString();

    // Always remove this device's session entry
    await db.ref(`deviceSessions/${deviceID}`).remove();

    // Only remove the user's active session if it matches this device.
    const userSessionRef = db.ref(`userSessions/${userID}`);
    const userSessionSnap = await userSessionRef.once('value');
    const currentDevice = userSessionSnap.exists() ? userSessionSnap.val().deviceID : null;

    if (currentDevice === deviceID) {
      await userSessionRef.remove();
      await db.ref(`users/${userID}/presence`).set({
        online: false,
        availabilityStatus: 'offline',
        deviceID: null,
        lastSeen: nowIso,
        updatedAt: nowIso
      });
    } else {
      // Don't flip presence offline if user is active on another device.
      await db.ref(`users/${userID}/presence/updatedAt`).set(nowIso);
    }

    res.json({ success: true, message: 'Device unbound successfully' });
  } catch (e) {
    console.error('Device unbinding failed:', e);
    res.status(500).json({ error: 'Failed to unbind device' });
  }
});


// ✅ Get incoming calls for owner  
router.get("/call/incoming", async (req, res) => {
  try {
    // Backward compatible: frontend currently passes `ownerID`, but we treat it as requesting user.
    const { userID, ownerID } = req.query;
    const requestingUserId = (userID || ownerID || "").toString();
    if (!requestingUserId) return res.status(400).json({ error: "Missing userID/ownerID" });

    // Only return calls for users that currently have an active session.
    const isOnline = await getUserIsOnline(requestingUserId);
    if (!isOnline) return res.json({ calls: [] });

    const familyGroupId = await getUserFamilyGroupId(requestingUserId);
    const snapshot = familyGroupId
      ? await db.ref("calls").orderByChild("familyGroupId").equalTo(familyGroupId).once("value")
      : await db.ref("calls").orderByChild("ownerID").equalTo(requestingUserId).once("value");

    const calls = [];
    snapshot.forEach((child) => {
      const call = child.val();
      if (call.status === "ringing") {
        if (call.sequentialRouting && call.currentTargetUserId) {
          if (String(call.currentTargetUserId) !== String(requestingUserId)) {
            return;
          }
        }
        calls.push({ ...call, callID: child.key });
      }
    });

    // Higher priority first
    calls.sort((a, b) => {
      const ra = PRIORITY_RANK[normalizePriority(a.priority)];
      const rb = PRIORITY_RANK[normalizePriority(b.priority)];
      return rb - ra;
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

// ✅ Rename doorbell (owner action)
router.post("/rename", async (req, res) => {
  try {
    const { doorID, ownerID, name } = req.body;
    if (!doorID || !ownerID) {
      return res.status(400).json({ error: "Missing doorID or ownerID" });
    }

    const trimmedName = (name ?? "").toString().trim();
    if (trimmedName.length === 0) {
      return res.status(400).json({ error: "Name cannot be empty" });
    }
    if (trimmedName.length > 40) {
      return res.status(400).json({ error: "Name too long (max 40)" });
    }

    // Store per-user so different owners (future) can name independently.
    await db.ref(`users/${ownerID}/doorbells/${doorID}/name`).set(trimmedName);

    // Also store on the door itself for convenience (visitor/admin views).
    await db.ref(`doors/${doorID}/name`).set(trimmedName);
    await db.ref(`doors/${doorID}/lastActivity`).set(new Date().toISOString());
    await db
      .ref(`users/${ownerID}/doorbells/${doorID}/lastActivity`)
      .set(new Date().toISOString());

    res.json({ success: true, message: "Doorbell renamed", name: trimmedName });
  } catch (error) {
    console.error("Rename failed:", error);
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
    const callFamilyGroupId = await getUserFamilyGroupId(ownerID);
    const callPriority = normalizePriority(req.body.priority);

    const channelName = `doorbell_${doorID}_${Date.now()}`;
    const token = generateAgoraToken(channelName);
    const callID = uuidv4();
    const createdAt = new Date().toISOString();

    if (callFamilyGroupId) {
      const routingQueue = await getRoutingMemberQueue(callFamilyGroupId);
      if (!routingQueue.length) {
        return res.status(409).json({ error: "No family members to route" });
      }

      const firstIdx = await findNextRoutableIndex(routingQueue, 0);
      if (firstIdx < 0) {
        return res.status(409).json({ error: "No online family devices to notify" });
      }

      const firstUid = routingQueue[firstIdx];
      const label = ownerLabelFromIndex(firstIdx);
      const ringDeadlineAt = new Date(Date.now() + RING_TIMEOUT_MS).toISOString();
      const visitorStatusMessage = `Calling ${label}...`;

      await db.ref(`calls/${callID}`).set({
        doorID,
        channelName,
        visitorName,
        status: 'ringing',
        token,
        createdAt,
        ownerPhone: doorData.ownerPhone || null,
        ownerID: firstUid,
        familyGroupId: callFamilyGroupId,
        doorOwnerId: ownerID,
        priority: callPriority,
        sequentialRouting: true,
        routingQueue,
        routingIndex: firstIdx,
        currentTargetUserId: firstUid,
        currentOwnerLabel: label,
        ringDeadlineAt,
        visitorStatusMessage,
        routingPhase: 'ringing',
      });

      await db.ref(`users/${firstUid}/callLogs/${callID}`).set({
        callID,
        visitorName: visitorName || 'Visitor',
        status: 'ringing',
        doorID,
        channelName,
        createdAt,
        updatedAt: createdAt,
      });

      await db.ref(`doors/${doorID}/lastActivity`).set(new Date().toISOString());
      await db.ref(`users/${doorData.claimedBy}/doorbells/${doorID}/lastActivity`).set(new Date().toISOString());

      await sendIncomingFcmToUsers([firstUid], {
        type: 'incoming_call',
        callID,
        channelName,
        token,
        visitorName: visitorName || 'Visitor',
        priority: callPriority,
        sequentialRouting: '1',
        currentOwnerLabel: label,
        routingIndex: String(firstIdx),
      }, androidPriorityFromCallPriority(callPriority));

      return res.json({
        success: true,
        callID,
        channelName,
        agoraAppId: AGORA_APP_ID,
        token,
        sequentialRouting: true,
        visitorStatusMessage,
        currentOwnerLabel: label,
      });
    }

    // Legacy: single owner, no family group
    const tokenList = (await getUserIsOnline(ownerID)) ? await getUserFcmTokens(ownerID) : [];
    if (!tokenList || tokenList.length === 0) {
      return res.status(409).json({ error: "No online family devices to notify" });
    }

    await db.ref(`calls/${callID}`).set({
      doorID,
      channelName,
      visitorName,
      status: 'ringing',
      token,
      createdAt,
      ownerPhone: doorData.ownerPhone || null,
      ownerID: ownerID || null,
      familyGroupId: null,
      priority: callPriority,
      sequentialRouting: false,
      visitorStatusMessage: 'Calling homeowner...',
      currentOwnerLabel: 'Owner',
    });

    await db.ref(`users/${ownerID}/callLogs/${callID}`).set({
      callID,
      visitorName: visitorName || 'Visitor',
      status: 'ringing',
      doorID,
      channelName,
      createdAt,
      updatedAt: createdAt,
    });

    await db.ref(`doors/${doorID}/lastActivity`).set(new Date().toISOString());
    await db.ref(`users/${doorData.claimedBy}/doorbells/${doorID}/lastActivity`).set(new Date().toISOString());

    try {
      const message = {
        notification: { title: 'Incoming Call', body: `Visitor: ${visitorName || ''}` },
        data: {
          type: 'incoming_call',
          callID,
          channelName,
          token,
          visitorName: visitorName || 'Visitor',
          sequentialRouting: '0',
          currentOwnerLabel: 'Owner',
        },
        android: { priority: androidPriorityFromCallPriority(callPriority) },
        apns: { headers: { 'apns-priority': '10' } },
        tokens: tokenList,
      };
      await messaging.sendEachForMulticast(message);
    } catch (err) {
      console.error('FCM send failed', err);
    }

    res.json({
      success: true,
      callID,
      channelName,
      agoraAppId: AGORA_APP_ID,
      token,
      sequentialRouting: false,
      visitorStatusMessage: 'Calling homeowner...',
      currentOwnerLabel: 'Owner',
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

    const { userID, userId } = req.body;
    const accepterUserId = (userID || userId || "").toString();
    if (!accepterUserId) {
      return res.status(400).json({ error: "Missing userID" });
    }

    const callData = await getCallDataOrThrow(callID);

    // Enforce that only family members (or the door owner if no family group) can accept.
    const callFamilyGroupId = callData.familyGroupId || (await getUserFamilyGroupId(callData.ownerID));
    if (callFamilyGroupId) {
      const role = await getUserRoleInFamilyGroup(callFamilyGroupId, accepterUserId);
      if (role !== "admin" && role !== "member") {
        return res.status(403).json({ error: "Not allowed to accept this call" });
      }
      if (callData.sequentialRouting && callData.currentTargetUserId) {
        if (String(accepterUserId) !== String(callData.currentTargetUserId)) {
          return res.status(403).json({ error: "Wait — another owner is being rung first" });
        }
      }
    } else {
      if (String(accepterUserId) !== String(callData.ownerID)) {
        return res.status(403).json({ error: "Not allowed to accept this call" });
      }
    }

    const updatedAt = new Date().toISOString();

    await db.ref(`users/${accepterUserId}/presence`).update({
      availabilityStatus: 'busy',
      busyCallId: callID,
      updatedAt: updatedAt,
    });

    // Mark acceptance and set the current handler/ownerID to the accepter.
    await db.ref(`calls/${callID}`).update({
      status: "accepted",
      acceptedAt: updatedAt,
      ownerID: accepterUserId,
      acceptedBy: accepterUserId,
      ringDeadlineAt: null,
      visitorStatusMessage: 'Connected',
      routingPhase: 'answered',
    });

    // Write/overwrite a call log entry under the user who accepted.
    await db.ref(`users/${accepterUserId}/callLogs/${callID}`).set({
      callID: callID,
      visitorName: callData.visitorName || "Visitor",
      status: "approved",
      doorID: callData.doorID || null,
      channelName: callData.channelName || null,
      createdAt: callData.createdAt || updatedAt,
      updatedAt: updatedAt,
      acceptedAt: updatedAt,
    });

    res.json({ success: true, message: "Call accepted", ownerID: accepterUserId });
  } catch (error) {
    console.error("Call acceptance failed:", error);
    const statusCode = error?.statusCode;
    res.status(statusCode || 500).json({ error: "Server error" });
  }
});

// ✅ Reject incoming ring (sequential — advances to next owner)
router.post('/call/:callID/reject', async (req, res) => {
  try {
    const { callID } = req.params;
    const { userID, userId } = req.body;
    const uid = (userID || userId || '').toString();
    if (!uid) return res.status(400).json({ error: 'Missing userID' });

    const callData = await getCallDataOrThrow(callID);
    if (callData.status !== 'ringing') {
      return res.status(409).json({ error: 'Call is not ringing' });
    }
    if (!callData.sequentialRouting) {
      return res.status(400).json({ error: 'Reject applies to family sequential calls only' });
    }
    if (String(uid) !== String(callData.currentTargetUserId)) {
      return res.status(403).json({ error: 'Not your turn for this call' });
    }

    await advanceSequentialRing(callID, true);
    res.json({ success: true });
  } catch (error) {
    console.error('Call reject failed:', error);
    const statusCode = error?.statusCode;
    res.status(statusCode || 500).json({ error: 'Server error' });
  }
});

// ✅ Change call priority (admin only)
router.post("/call/:callID/priority", async (req, res) => {
  try {
    const { callID } = req.params;
    const { userID, userId, priority } = req.body;

    const actorUserId = (userID || userId || "").toString();
    if (!actorUserId) return res.status(400).json({ error: "Missing userID" });

    const callData = await getCallDataOrThrow(callID);
    const callFamilyGroupId = callData.familyGroupId || (await getUserFamilyGroupId(callData.ownerID));

    if (callFamilyGroupId) {
      const role = await getUserRoleInFamilyGroup(callFamilyGroupId, actorUserId);
      if (role !== "admin") {
        return res.status(403).json({ error: "Only admins can change call priority" });
      }
    } else {
      // No family group: only door owner can change priority.
      if (String(actorUserId) !== String(callData.ownerID)) {
        return res.status(403).json({ error: "Not allowed to change call priority" });
      }
    }

    const newPriority = normalizePriority(priority);

    if (callData.status === "ended") {
      return res.status(409).json({ error: "Cannot change priority for ended calls" });
    }

    await db.ref(`calls/${callID}`).update({
      priority: newPriority,
      updatedAt: new Date().toISOString(),
    });

    let notifyUserIds = [];
    if (callFamilyGroupId && callData.sequentialRouting && callData.status === 'ringing' && callData.currentTargetUserId) {
      notifyUserIds = [callData.currentTargetUserId];
    } else if (callFamilyGroupId) {
      const memberIds = await getFamilyMemberIds(callFamilyGroupId);
      for (const mid of memberIds) {
        if (await getUserIsOnline(mid)) notifyUserIds.push(mid);
      }
    } else if (await getUserIsOnline(callData.ownerID)) {
      notifyUserIds = [callData.ownerID];
    }

    const familyGroupTokens = [];
    for (const uid of notifyUserIds) {
      const ts = await getUserFcmTokens(uid);
      for (const t of ts) {
        if (t && !familyGroupTokens.includes(t)) familyGroupTokens.push(t);
      }
    }

    if (familyGroupTokens.length === 0) {
      return res.status(409).json({ error: "No online devices to notify" });
    }

    const message = {
      notification: {
        title: "Incoming Call",
        body: `Visitor: ${callData.visitorName || ""}`,
      },
      data: {
        type: "incoming_call",
        callID: callID,
        channelName: callData.channelName,
        token: callData.token,
        visitorName: callData.visitorName || "Visitor",
        priority: newPriority,
        sequentialRouting: callData.sequentialRouting ? '1' : '0',
        currentOwnerLabel: callData.currentOwnerLabel || '',
      },
      android: { priority: androidPriorityFromCallPriority(newPriority) },
      apns: { headers: { "apns-priority": "10" } },
      tokens: familyGroupTokens,
    };

    await messaging.sendEachForMulticast(message);
    res.json({ success: true, callID, priority: newPriority });
  } catch (error) {
    console.error("Call priority change failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Forward an incoming call to another family member
router.post("/call/:callID/forward", async (req, res) => {
  try {
    const { callID } = req.params;
    const { fromUserID, fromUserId, toUserID, toUserId } = req.body;

    const fromUser = (fromUserID || fromUserId || "").toString();
    const toUser = (toUserID || toUserId || "").toString();
    if (!fromUser || !toUser) {
      return res.status(400).json({ error: "Missing fromUserID/toUserID" });
    }

    const callData = await getCallDataOrThrow(callID);
    const callFamilyGroupId = callData.familyGroupId || (await getUserFamilyGroupId(callData.ownerID));

    if (!callFamilyGroupId) {
      return res.status(403).json({ error: "Forwarding requires a family group" });
    }
    if (callData.sequentialRouting) {
      return res.status(409).json({ error: "Manual forward disabled during sequential routing" });
    }

    const fromRole = await getUserRoleInFamilyGroup(callFamilyGroupId, fromUser);
    const toRole = await getUserRoleInFamilyGroup(callFamilyGroupId, toUser);
    if ((fromRole !== "admin" && fromRole !== "member") || (toRole !== "admin" && toRole !== "member")) {
      return res.status(403).json({ error: "Not allowed to forward to this user" });
    }

    if (callData.status !== "ringing") {
      return res.status(409).json({ error: "Call is not in a forwardable state" });
    }

    // Ensure the target is online and has devices.
    if (!(await getUserIsOnline(toUser))) {
      return res.status(409).json({ error: "Target user is offline" });
    }
    const toTokens = await getUserFcmTokens(toUser);
    if (!toTokens || toTokens.length === 0) {
      return res.status(409).json({ error: "Target user has no registered devices" });
    }

    const nowIso = new Date().toISOString();

    // Move the handler/ownerID to the forwarded user.
    await db.ref(`calls/${callID}`).update({
      ownerID: toUser,
      forwardedAt: nowIso,
      previousOwnerID: callData.ownerID || null,
      updatedAt: nowIso,
      status: "ringing",
    });

    const callPriority = normalizePriority(callData.priority);
    const message = {
      notification: {
        title: "Incoming Call",
        body: `Visitor: ${callData.visitorName || ""}`,
      },
      data: {
        type: "incoming_call",
        callID: callID,
        channelName: callData.channelName,
        token: callData.token,
        visitorName: callData.visitorName || "Visitor",
        forwardedBy: fromUser,
        priority: callPriority,
      },
      android: { priority: androidPriorityFromCallPriority(callPriority) },
      apns: { headers: { "apns-priority": "10" } },
      tokens: toTokens,
    };

    await messaging.sendEachForMulticast(message);
    res.json({ success: true, callID, forwardedTo: toUser });
  } catch (error) {
    console.error("Call forwarding failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Transfer sequential ring to a specific family member (ringing phase)
router.post("/call/:callID/transfer", async (req, res) => {
  try {
    const { callID } = req.params;
    const { fromUserID, fromUserId, toUserID, toUserId } = req.body;

    const fromUser = (fromUserID || fromUserId || "").toString();
    const toUser = (toUserID || toUserId || "").toString();
    if (!fromUser || !toUser) {
      return res.status(400).json({ error: "Missing fromUserID/toUserID" });
    }

    const callData = await getCallDataOrThrow(callID);
    if (!callData.sequentialRouting) {
      return res.status(409).json({ error: "Transfer is for sequential routing calls only" });
    }
    if (callData.status !== "ringing") {
      return res.status(409).json({ error: "Call is not in ringing state" });
    }
    if (String(callData.currentTargetUserId) !== String(fromUser)) {
      return res.status(403).json({ error: "Only the currently rung owner can transfer" });
    }

    const callFamilyGroupId = callData.familyGroupId || (await getUserFamilyGroupId(callData.ownerID));
    if (!callFamilyGroupId) {
      return res.status(403).json({ error: "Transfer requires a family group" });
    }

    const fromRole = await getUserRoleInFamilyGroup(callFamilyGroupId, fromUser);
    const toRole = await getUserRoleInFamilyGroup(callFamilyGroupId, toUser);
    if ((fromRole !== "admin" && fromRole !== "member") ||
        (toRole !== "admin" && toRole !== "member")) {
      return res.status(403).json({ error: "Both users must be family members" });
    }
    if (String(fromUser) === String(toUser)) {
      return res.status(400).json({ error: "Cannot transfer to same user" });
    }
    if (!(await isUserRoutable(toUser))) {
      return res.status(409).json({ error: "Target owner is unavailable" });
    }

    const queue = Array.isArray(callData.routingQueue)
      ? callData.routingQueue.map(String)
      : [];
    const idx = queue.indexOf(String(toUser));
    if (idx < 0) {
      return res.status(403).json({ error: "Target not in routing queue" });
    }

    const label = ownerLabelFromIndex(idx);
    const ringDeadlineAt = new Date(Date.now() + RING_TIMEOUT_MS).toISOString();
    const updatedAt = new Date().toISOString();
    const pri = normalizePriority(callData.priority);

    await db.ref(`calls/${callID}`).update({
      ownerID: toUser,
      currentTargetUserId: toUser,
      currentOwnerLabel: label,
      routingIndex: idx,
      ringDeadlineAt,
      visitorStatusMessage: `Calling ${label}...`,
      updatedAt,
      routedBy: fromUser,
    });

    await sendIncomingFcmToUsers([toUser], {
      type: 'incoming_call',
      callID,
      channelName: callData.channelName,
      token: callData.token,
      visitorName: callData.visitorName || 'Visitor',
      priority: pri,
      sequentialRouting: '1',
      currentOwnerLabel: label,
      routingIndex: String(idx),
    }, androidPriorityFromCallPriority(pri));

    await sendRingCancelledFcmToUsers([fromUser], {
      callID,
      reason: "transferred",
    });

    res.json({ success: true, callID, forwardedTo: toUser, currentOwnerLabel: label });
  } catch (error) {
    console.error("Call transfer failed:", error);
    const statusCode = error?.statusCode;
    res.status(statusCode || 500).json({ error: "Server error" });
  }
});

// ✅ End call
router.post("/call/:callID/end", async (req, res) => {
  try {
    const { callID } = req.params;

    const { userID, userId } = req.body;
    let actorUserId = (userID || userId || "").toString();

    const callData = await getCallDataOrThrow(callID);

    if (!actorUserId) {
      if (callData.status !== "ringing" && callData.status !== "accepted") {
        return res.status(400).json({ error: "Call already ended" });
      }
      const endedAt = new Date().toISOString();
      await db.ref(`calls/${callID}`).update({
        status: "ended",
        endedAt,
        endedBy: "visitor",
        visitorStatusMessage:
          callData.status === "ringing" ? "Visitor cancelled" : "Call ended",
        ringDeadlineAt: null,
      });
      if (
        callData.sequentialRouting &&
        callData.status === "ringing" &&
        callData.currentTargetUserId
      ) {
        await sendRingCancelledFcmToUsers([String(callData.currentTargetUserId)], {
          callID,
          reason: "visitor_hangup",
        });
      }
      if (callData.acceptedBy) await clearBusyForUser(callData.acceptedBy);
      return res.json({ success: true, message: "Call ended" });
    }

    const callFamilyGroupId = callData.familyGroupId || (await getUserFamilyGroupId(callData.ownerID));
    if (callFamilyGroupId) {
      const role = await getUserRoleInFamilyGroup(callFamilyGroupId, actorUserId);
      if (role !== "admin" && role !== "member") {
        return res.status(403).json({ error: "Not allowed to end this call" });
      }
    } else {
      if (String(actorUserId) !== String(callData.ownerID)) {
        return res.status(403).json({ error: "Not allowed to end this call" });
      }
    }

    const currentStatus = callData.status;
    const endedAt = new Date().toISOString();

    await db.ref(`calls/${callID}`).update({
      status: "ended",
      endedAt: endedAt,
      endedBy: actorUserId,
      ringDeadlineAt: null,
    });

    if (callData.acceptedBy) await clearBusyForUser(callData.acceptedBy);

    let logStatus = "declined";
    if (currentStatus === "accepted") {
      logStatus = "approved";
    }

    await db.ref(`users/${actorUserId}/callLogs/${callID}`).set({
      callID: callID,
      visitorName: callData.visitorName || "Visitor",
      status: logStatus,
      doorID: callData.doorID || null,
      channelName: callData.channelName || null,
      createdAt: callData.createdAt || endedAt,
      updatedAt: endedAt,
      acceptedAt: callData.acceptedAt || null,
      endedAt: endedAt,
    });

    res.json({ success: true, message: "Call ended" });
  } catch (error) {
    console.error("Call ending failed:", error);
    const statusCode = error?.statusCode;
    res.status(statusCode || 500).json({ error: "Server error" });
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

// Sequential routing: advance ring target when deadline passes
setInterval(async () => {
  try {
    const snapshot = await db.ref('calls').once('value');
    const tasks = [];
    snapshot.forEach((child) => {
      const call = child.val();
      if (call.status === 'ringing' && call.sequentialRouting) {
        tasks.push(advanceSequentialRing(child.key, false));
      }
    });
    await Promise.all(tasks);
  } catch (err) {
    console.error('Error during routing advance:', err);
  }
}, 5000);

// Scheduled cleanup to auto-end long-running calls (max 3 minutes)
setInterval(async () => {
  try {
    const now = Date.now();
    const maxDurationMs = 3 * 60 * 1000; // 3 minutes
    const snapshot = await db.ref('calls').once('value');
    snapshot.forEach(child => {
      const call = child.val();
      if ((call.status === 'ringing' || call.status === 'accepted') && call.createdAt) {
        const createdAt = new Date(call.createdAt).getTime();
        if (now - createdAt > maxDurationMs) {
          const updates = {
            status: 'ended',
            endedAt: new Date().toISOString(),
            endedBy: 'system_timeout',
            ringDeadlineAt: null,
          };
          if (call.status === 'ringing' && call.sequentialRouting) {
            updates.visitorStatusMessage = 'Call timed out';
            updates.routingPhase = 'timeout';
          }
          db.ref(`calls/${child.key}`).update(updates);
          if (call.acceptedBy) {
            clearBusyForUser(call.acceptedBy);
          }
          console.log(`Auto-ended call after 3 minutes: ${child.key}`);
        }
      }
    });
  } catch (err) {
    console.error('Error during call cleanup:', err);
  }
}, 30 * 1000); // Check roughly every 30 seconds

module.exports = router;
