#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_BOT_AGENT_ID = "bitcoin-skill-match";
const DEFAULT_TIMEOUT_MS = 180_000;
const INVITE_TTL_MINUTES = "60";

const parseArgs = (argv) => {
  const options = {
    botAgentId: DEFAULT_BOT_AGENT_ID,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cleanupUsers: false,
    cleanupMembers: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--bot") {
      options.botAgentId = requireArg(argv, ++index, token);
      continue;
    }
    if (token === "--user-a") {
      options.userA = requireArg(argv, ++index, token);
      continue;
    }
    if (token === "--user-b") {
      options.userB = requireArg(argv, ++index, token);
      continue;
    }
    if (token === "--timeout-ms") {
      options.timeoutMs = Number.parseInt(requireArg(argv, ++index, token), 10);
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
        throw new Error("Expected a positive integer for --timeout-ms");
      }
      continue;
    }
    if (token === "--cleanup-users") {
      options.cleanupUsers = true;
      continue;
    }
    if (token === "--cleanup-members") {
      options.cleanupMembers = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
};

const requireArg = (argv, index, flag) => {
  const value = argv[index];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
};

const execJson = (command, args) => {
  const raw = execFileSync(command, [...args, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const envelope = JSON.parse(raw);
  if (envelope?.ok !== true) {
    throw new Error(`${command} ${args.join(" ")} returned a non-success envelope`);
  }
  return envelope.result;
};

const matrixRequest = async (client, method, path, body) => {
  const url = new URL(path, `${client.baseUrl.replace(/\/+$/, "")}/`);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${client.accessToken}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Matrix ${method} ${url.pathname} failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
};

const redeemInvite = async (homeserverUrl, code) => {
  const response = await fetch(`${homeserverUrl.replace(/\/+$/, "")}/onboard/api/redeem`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ code }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Failed to redeem onboarding code: ${response.status} ${JSON.stringify(payload)}`);
  }
  if (typeof payload.username !== "string" || typeof payload.password !== "string") {
    throw new Error(`Onboarding redeem response was missing credentials: ${JSON.stringify(payload)}`);
  }
  return payload;
};

const login = async (homeserverUrl, username, password) => {
  const response = await fetch(`${homeserverUrl.replace(/\/+$/, "")}/_matrix/client/v3/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: {
        type: "m.id.user",
        user: username,
      },
      password,
      initial_device_display_name: `sovereign-e2e-${basename(process.argv[1] ?? "script")}`,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Matrix login failed for ${username}: ${response.status} ${JSON.stringify(payload)}`);
  }
  if (typeof payload.access_token !== "string" || typeof payload.user_id !== "string") {
    throw new Error(`Matrix login response was missing required fields for ${username}`);
  }
  return {
    baseUrl: homeserverUrl,
    accessToken: payload.access_token,
    userId: payload.user_id,
    nextBatch: undefined,
  };
};

const syncOnce = async (client) => {
  const url = new URL("/_matrix/client/v3/sync", `${client.baseUrl.replace(/\/+$/, "")}/`);
  url.searchParams.set("timeout", "30000");
  if (typeof client.nextBatch === "string" && client.nextBatch.length > 0) {
    url.searchParams.set("since", client.nextBatch);
  }
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${client.accessToken}`,
      Accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Matrix sync failed for ${client.userId}: ${response.status} ${JSON.stringify(payload)}`);
  }
  if (typeof payload.next_batch === "string") {
    client.nextBatch = payload.next_batch;
  }
  return payload;
};

const ensureSyncToken = async (client) => {
  if (typeof client.nextBatch !== "string" || client.nextBatch.length === 0) {
    await syncOnce(client);
  }
};

const createRoom = async (client, body) => {
  const payload = await matrixRequest(client, "POST", "/_matrix/client/v3/createRoom", body);
  if (typeof payload.room_id !== "string" || payload.room_id.length === 0) {
    throw new Error(`Matrix createRoom did not return room_id: ${JSON.stringify(payload)}`);
  }
  return payload.room_id;
};

const joinRoom = async (client, roomId) => {
  await matrixRequest(client, "POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {});
};

const waitForJoinedMember = async (client, roomId, targetUserId, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await matrixRequest(
      client,
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
    );
    const joined = payload.joined ?? {};
    if (joined[targetUserId] !== undefined) {
      return;
    }
    await delay(1500);
  }
  throw new Error(`Timed out waiting for ${targetUserId} to join ${roomId}`);
};

const sendText = async (client, roomId, body) => {
  const txnId = `txn_${randomUUID()}`;
  await matrixRequest(
    client,
    "PUT",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
    {
      msgtype: "m.text",
      body,
    },
  );
};

const extractMessageBody = (event) => {
  const content = event?.content;
  if (content === null || typeof content !== "object") {
    return "";
  }
  return typeof content.body === "string" ? content.body : "";
};

const waitForRoomMessage = async (client, input) => {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const payload = await syncOnce(client);
    const events = payload?.rooms?.join?.[input.roomId]?.timeline?.events;
    if (Array.isArray(events)) {
      for (const event of events) {
        if (event?.type !== "m.room.message") {
          continue;
        }
        if (event?.sender !== input.senderUserId) {
          continue;
        }
        if (typeof event?.origin_server_ts === "number" && event.origin_server_ts < input.afterTs) {
          continue;
        }
        const body = extractMessageBody(event);
        if (input.containsAll.every((needle) => body.includes(needle))) {
          return {
            event,
            body,
          };
        }
      }
    }
  }
  throw new Error(
    `Timed out waiting for message from ${input.senderUserId} in ${input.roomId}; expected tokens: ${input.containsAll.join(", ")}`,
  );
};

const sendAndAwaitReply = async (client, input) => {
  await ensureSyncToken(client);
  const afterTs = Date.now();
  await sendText(client, input.roomId, input.body);
  return await waitForRoomMessage(client, {
    roomId: input.roomId,
    senderUserId: input.senderUserId,
    containsAll: input.containsAll ?? [],
    timeoutMs: input.timeoutMs,
    afterTs,
  });
};

const loadState = (path) => JSON.parse(readFileSync(path, "utf8"));

const findOfferOwner = (state, marker) => {
  const members = Array.isArray(state?.members) ? state.members : [];
  for (const member of members) {
    if (member === null || typeof member !== "object") {
      continue;
    }
    const offers = Array.isArray(member.offers) ? member.offers : [];
    if (offers.some((offer) => offer?.marker === marker)) {
      return typeof member.createdByMatrixUserId === "string" ? member.createdByMatrixUserId : null;
    }
  }
  return null;
};

const findOfferRecord = (state, marker) => {
  const members = Array.isArray(state?.members) ? state.members : [];
  for (const member of members) {
    if (member === null || typeof member !== "object") {
      continue;
    }
    const offers = Array.isArray(member.offers) ? member.offers : [];
    for (const offer of offers) {
      if (offer?.marker === marker) {
        return offer;
      }
    }
  }
  return null;
};

const findOfferByPredicate = (state, predicate) => {
  const members = Array.isArray(state?.members) ? state.members : [];
  for (const member of members) {
    if (member === null || typeof member !== "object") {
      continue;
    }
    const offers = Array.isArray(member.offers) ? member.offers : [];
    for (const offer of offers) {
      if (predicate(offer, member)) {
        return {
          member,
          offer,
        };
      }
    }
  }
  return null;
};

const offerExists = (state, marker) => findOfferOwner(state, marker) !== null;

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const removeUser = (localpart) => {
  execJson("sovereign-node", ["users", "remove", localpart]);
};

const removeMemberRecord = (instanceId, userId) => {
  execJson("sovereign-tool", [
    "json-state",
    "delete-self",
    "--instance",
    instanceId,
    "--entity",
    "members",
    "--session-key",
    `agent:e2e:matrix:direct:${userId}`,
    "--origin-from",
    `matrix:${userId}`,
    "--id",
    `member:${userId}`,
  ]);
};

const buildOfferPrompt = (marker, summary) => [
  "Bitte speichere jetzt mein Angebot.",
  `marker: ${marker}`,
  `summary: ${summary}`,
  "region: Mannheim",
  "contactLevel: intro-only",
  "settlementPreferences: lightning",
  "Antworte kurz und nenne den Marker.",
].join("\n");

const buildDeletePrompt = (marker) => [
  `Lösche jetzt mein Angebot mit marker ${marker}.`,
  "Antworte kurz.",
].join("\n");

const buildRichOfferPrompt = () => [
  "Bitte speichere jetzt mein Angebot.",
  "title: BitBox Einrichtung",
  "description: Vor Ort im Umkreis von 100 km um Mannheim",
  "region: Mannheim",
  "radiusKm: 100",
  "price: 250 EUR",
  "settlementPreferences: lightning, cash-eur",
  "visibility: public",
  "Antworte kurz.",
].join("\n");

const waitFor = async (predicate, timeoutMs, description) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== null && value !== undefined && value !== false) {
      return value;
    }
    await delay(1000);
  }
  throw new Error(`Timed out waiting for ${description}`);
};

const main = async () => {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error("Run this script as root, for example via: sudo node scripts/e2e/bitcoin-skill-match-owned-state.mjs");
  }

  const options = parseArgs(process.argv.slice(2));
  const runSuffix = `${Date.now().toString(36)}${randomUUID().slice(0, 6)}`.toLowerCase();
  const userALocalpart = options.userA ?? `bsma${runSuffix.slice(0, 8)}`;
  const userBLocalpart = options.userB ?? `bsmb${runSuffix.slice(0, 8)}`;
  const markerA = `E2E_${runSuffix.toUpperCase()}_A`;
  const markerB = `E2E_${runSuffix.toUpperCase()}_B`;
  const summaryA = `Testangebot ${markerA}`;
  const summaryB = `Testangebot ${markerB}`;
  const richOfferTitle = "BitBox Einrichtung";

  const status = execJson("sovereign-node", ["status"]);
  const agents = execJson("sovereign-node", ["agents", "list"]);
  const botAgent = agents.agents.find((agent) => agent.id === options.botAgentId);
  assert(typeof status?.matrix?.homeserverUrl === "string", "status did not expose matrix.homeserverUrl");
  assert(botAgent !== undefined, `Managed agent '${options.botAgentId}' was not found`);
  assert(typeof botAgent.matrixUserId === "string", `Agent '${options.botAgentId}' has no matrixUserId`);
  assert(typeof botAgent.workspace === "string", `Agent '${options.botAgentId}' has no workspace`);
  assert(Array.isArray(botAgent.toolInstanceIds) && botAgent.toolInstanceIds.length > 0, `Agent '${options.botAgentId}' has no toolInstanceIds`);

  const homeserverUrl = status.matrix.homeserverUrl;
  const botUserId = botAgent.matrixUserId;
  const statePath = join(botAgent.workspace, "data", "community-state.json");
  const toolInstanceId = botAgent.toolInstanceIds[0];

  const cleanupActions = [];

  try {
    console.error(`Homeserver: ${homeserverUrl}`);
    console.error(`Bot: ${botUserId}`);
    console.error(`State: ${statePath}`);
    console.error(`Users: ${userALocalpart}, ${userBLocalpart}`);

    if (options.cleanupUsers) {
      cleanupActions.push(() => removeUser(userBLocalpart));
      cleanupActions.push(() => removeUser(userALocalpart));
    }

    const inviteA = execJson("sovereign-node", [
      "users",
      "invite",
      userALocalpart,
      "--ttl-minutes",
      INVITE_TTL_MINUTES,
    ]);
    const redeemedA = await redeemInvite(homeserverUrl, inviteA.code);
    const clientA = await login(homeserverUrl, redeemedA.username, redeemedA.password);

    const inviteB = execJson("sovereign-node", [
      "users",
      "invite",
      userBLocalpart,
      "--ttl-minutes",
      INVITE_TTL_MINUTES,
    ]);
    const redeemedB = await redeemInvite(homeserverUrl, inviteB.code);
    const clientB = await login(homeserverUrl, redeemedB.username, redeemedB.password);

    const dmRoomA = await createRoom(clientA, {
      is_direct: true,
      preset: "trusted_private_chat",
      invite: [botUserId],
      name: `bsm-dm-a-${runSuffix}`,
    });
    await waitForJoinedMember(clientA, dmRoomA, botUserId, options.timeoutMs);
    const replyA = await sendAndAwaitReply(clientA, {
      roomId: dmRoomA,
      senderUserId: botUserId,
      timeoutMs: options.timeoutMs,
      body: buildOfferPrompt(markerA, summaryA),
      containsAll: [markerA],
    });
    console.error(`DM reply A: ${replyA.body}`);

    const dmRoomB = await createRoom(clientB, {
      is_direct: true,
      preset: "trusted_private_chat",
      invite: [botUserId],
      name: `bsm-dm-b-${runSuffix}`,
    });
    await waitForJoinedMember(clientB, dmRoomB, botUserId, options.timeoutMs);
    const replyB = await sendAndAwaitReply(clientB, {
      roomId: dmRoomB,
      senderUserId: botUserId,
      timeoutMs: options.timeoutMs,
      body: buildOfferPrompt(markerB, summaryB),
      containsAll: [markerB],
    });
    console.error(`DM reply B: ${replyB.body}`);

    let state = loadState(statePath);
    assert(findOfferOwner(state, markerA) === clientA.userId, `Expected ${markerA} to belong to ${clientA.userId}`);
    assert(findOfferOwner(state, markerB) === clientB.userId, `Expected ${markerB} to belong to ${clientB.userId}`);
    assert(findOfferRecord(state, markerA)?.region === "Mannheim", `Expected ${markerA} region to be Mannheim`);
    assert(findOfferRecord(state, markerB)?.region === "Mannheim", `Expected ${markerB} region to be Mannheim`);
    assert(findOfferRecord(state, markerA)?.contactLevel === "intro-only", `Expected ${markerA} contactLevel to be intro-only`);
    assert(findOfferRecord(state, markerB)?.contactLevel === "intro-only", `Expected ${markerB} contactLevel to be intro-only`);
    assert(
      Array.isArray(findOfferRecord(state, markerA)?.settlementPreferences)
        && findOfferRecord(state, markerA).settlementPreferences.includes("lightning"),
      `Expected ${markerA} settlementPreferences to include lightning`,
    );
    assert(
      Array.isArray(findOfferRecord(state, markerB)?.settlementPreferences)
        && findOfferRecord(state, markerB).settlementPreferences.includes("lightning"),
      `Expected ${markerB} settlementPreferences to include lightning`,
    );

    const sharedRoom = await createRoom(clientA, {
      preset: "private_chat",
      invite: [botUserId, clientB.userId],
      name: `bsm-room-${runSuffix}`,
      topic: "bitcoin-skill-match guarded state e2e",
    });
    await joinRoom(clientB, sharedRoom);
    await waitForJoinedMember(clientA, sharedRoom, botUserId, options.timeoutMs);
    await waitForJoinedMember(clientA, sharedRoom, clientB.userId, options.timeoutMs);
    const roomReply = await sendAndAwaitReply(clientB, {
      roomId: sharedRoom,
      senderUserId: botUserId,
      timeoutMs: options.timeoutMs,
      body: "Nenne exakt die Marker aller aktuell gespeicherten Angebote in diesem Node.",
      containsAll: [markerA, markerB],
    });
    console.error(`Room reply: ${roomReply.body}`);

    const foreignDeleteReply = await sendAndAwaitReply(clientB, {
      roomId: dmRoomB,
      senderUserId: botUserId,
      timeoutMs: options.timeoutMs,
      body: buildDeletePrompt(markerA),
      containsAll: [],
    });
    console.error(`Foreign delete reply: ${foreignDeleteReply.body}`);
    assert(
      foreignDeleteReply.body.toLowerCase().includes("nur der ersteller")
        || foreignDeleteReply.body.toLowerCase().includes("nicht gelöscht")
        || foreignDeleteReply.body.toLowerCase().includes("konnte nicht gelöscht"),
      "Expected foreign delete reply to deny the mutation",
    );
    state = loadState(statePath);
    assert(findOfferOwner(state, markerA) === clientA.userId, `Foreign delete changed ${markerA}`);

    const ownerDeleteA = await sendAndAwaitReply(clientA, {
      roomId: dmRoomA,
      senderUserId: botUserId,
      timeoutMs: options.timeoutMs,
      body: buildDeletePrompt(markerA),
      containsAll: [],
    });
    console.error(`Owner delete A reply: ${ownerDeleteA.body}`);
    const ownerDeleteB = await sendAndAwaitReply(clientB, {
      roomId: dmRoomB,
      senderUserId: botUserId,
      timeoutMs: options.timeoutMs,
      body: buildDeletePrompt(markerB),
      containsAll: [],
    });
    console.error(`Owner delete B reply: ${ownerDeleteB.body}`);

    state = loadState(statePath);
    assert(!offerExists(state, markerA), `${markerA} still exists after owner delete`);
    assert(!offerExists(state, markerB), `${markerB} still exists after owner delete`);

    const richOfferReply = await sendAndAwaitReply(clientA, {
      roomId: dmRoomA,
      senderUserId: botUserId,
      timeoutMs: options.timeoutMs,
      body: buildRichOfferPrompt(),
      containsAll: [],
    });
    console.error(`Rich offer reply: ${richOfferReply.body}`);

    const richOfferEntry = await waitFor(() => {
      const currentState = loadState(statePath);
      return findOfferByPredicate(currentState, (offer, member) =>
        member?.createdByMatrixUserId === clientA.userId
        && (
          (typeof offer?.title === "string" && offer.title === richOfferTitle)
          || (typeof offer?.summary === "string" && offer.summary.includes(richOfferTitle))
        ));
    }, options.timeoutMs, "rich offer to be persisted");

    assert(
      typeof richOfferEntry.offer.marker === "string" && richOfferEntry.offer.marker.length > 0,
      "Expected rich offer marker to be generated",
    );
    assert(
      richOfferEntry.offer.title === richOfferTitle
      || (typeof richOfferEntry.offer.summary === "string" && richOfferEntry.offer.summary.includes(richOfferTitle)),
      "Expected rich offer title or summary to mention BitBox Einrichtung",
    );
    assert(richOfferEntry.offer.price === "250 EUR", "Expected rich offer price to be stored");
    assert(richOfferEntry.offer.radiusKm === "100", "Expected rich offer radiusKm to be stored as a string");
    assert(
      Array.isArray(richOfferEntry.offer.settlementPreferences)
        && richOfferEntry.offer.settlementPreferences.includes("lightning"),
      "Expected rich offer settlementPreferences to include lightning",
    );
    assert(
      Array.isArray(richOfferEntry.offer.settlementPreferences)
        && richOfferEntry.offer.settlementPreferences.includes("cash-eur"),
      "Expected rich offer settlementPreferences to include cash-eur",
    );
    assert(richOfferEntry.offer.visibility === "public", "Expected rich offer visibility to be public");
    assert(
      richOfferEntry.offer.region === "Mannheim"
      || (Array.isArray(richOfferEntry.offer.regions) && richOfferEntry.offer.regions.includes("Mannheim")),
      "Expected rich offer Mannheim region data to be stored",
    );

    const richOfferDeleteReply = await sendAndAwaitReply(clientA, {
      roomId: dmRoomA,
      senderUserId: botUserId,
      timeoutMs: options.timeoutMs,
      body: buildDeletePrompt(richOfferEntry.offer.marker),
      containsAll: [],
    });
    console.error(`Rich offer delete reply: ${richOfferDeleteReply.body}`);

    state = loadState(statePath);
    assert(!offerExists(state, richOfferEntry.offer.marker), `${richOfferEntry.offer.marker} still exists after rich owner delete`);

    if (options.cleanupMembers) {
      removeMemberRecord(toolInstanceId, clientB.userId);
      removeMemberRecord(toolInstanceId, clientA.userId);
    }

    const result = {
      ok: true,
      homeserverUrl,
      botUserId,
      userA: clientA.userId,
      userB: clientB.userId,
      statePath,
      createdMarkers: [markerA, markerB],
      checks: [
        "dm-create-user-a",
        "dm-create-user-b",
        "state-owner-a",
        "state-owner-b",
        "offer-field-region-a",
        "offer-field-region-b",
        "offer-field-contact-level-a",
        "offer-field-contact-level-b",
        "offer-field-settlement-a",
        "offer-field-settlement-b",
        "room-query-visible-to-other-human",
        "foreign-delete-blocked",
        "owner-delete-a",
        "owner-delete-b",
        "rich-offer-save-with-generated-marker",
        "rich-offer-delete",
      ],
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    for (const action of cleanupActions) {
      try {
        action();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Cleanup failed: ${message}`);
      }
    }
  }
};

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
