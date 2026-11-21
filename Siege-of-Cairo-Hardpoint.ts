const CP_COUNT = 10; // indices 0..9 → CPs 200-209 / sectors 300-309
const CP_ID_BASE = 200;
const SECTOR_ID_BASE = 300;
const CENTER_CP_ID = 250;
const CENTER_SECTOR_ID = 350;
const ROTATE_SECONDS = 75;
const MATCH_TIME_SECONDS = 20 * 60;
const TARGET_SCORE = 50;

const SCORE_KILL = 100;
const SCORE_ASSIST = 50;
const SCORE_REVIVE = 75;
const SCORE_HILL_PER_SECOND = 10;

const PREVIEW_ICON_ID = 400;
const PREVIEW_SECONDS = 30;
const PREVIEW_LINGER_SECONDS = 10;
const PREVIEW_ICON_HEIGHT = 2;

let team1ScoreTimer = 0;
let team2ScoreTimer = 0;

/** Index (0..5) of the active rotating capture point, or -1 while center opener is up. */
let activeCpIndex = -1;
let elapsedSeconds = 0;
let nextRotateAt = -1;

/** One-shot center objective (250 / 350) — always opens, never re-enters the loop. */
let centerActive = false;
let centerCp: mod.CapturePoint;
let centerSector: mod.Sector;
let centerPosition: mod.Vector;

/** Single movable WorldIcon for COD-style next-hill preview. */
let previewIcon: mod.WorldIcon;
/** Cached upcoming rotating CP index while preview is up; -1 when none. */
let previewedNextIndex = -1;
let previewVisible = false;
/** Hide preview icon at this elapsed second; -1 when not lingering. */
let previewHideAt = -1;

/** Assist counts keyed by mod.GetObjId(player). Engine has no GetPlayerAssists. */
const playerAssists: number[] = [];
/** Personal combat score keyed by mod.GetObjId(player). */
const playerScores: number[] = [];
/** Cached K/D — engine GetPlayerKills/Deaths can read as 0 on the end screen for the other team. */
const playerKills: number[] = [];
const playerDeaths: number[] = [];

/** Pairwise distances between rotating CPs (built once at match start). */
const cpDistances: number[][] = [];
/** World positions of rotating CPs (for first handoff from center). */
const cpPositions: mod.Vector[] = [];
/** Oldest → newest indices of recently active rotating CPs (fixed buffer, no push/shift). */
const RECENT_CP_MAX = 3;
const recentCpSlots: number[] = [-1, -1, -1];
let recentCpCount = 0;

export async function OnGameModeStarted() {

    // Custom modes often report 0 remaining until a limit is set — without this,
    // the tick loop never runs (no scoring, no rotation).
    mod.SetGameModeTimeLimit(MATCH_TIME_SECONDS);

    const capturePoints: mod.CapturePoint[] = [];
    const sectors: mod.Sector[] = [];
    for (var i = 0; i < CP_COUNT; i++) {
        const cp = mod.GetCapturePoint(CP_ID_BASE + i);
        const sector = mod.GetSector(SECTOR_ID_BASE + i);
        capturePoints.push(cp);
        sectors.push(sector);
        configureCapturePoint(cp);
        mod.EnableGameModeObjective(cp, false);
        mod.EnableGameModeObjective(sector, false);
    }

    centerCp = mod.GetCapturePoint(CENTER_CP_ID);
    centerSector = mod.GetSector(CENTER_SECTOR_ID);
    configureCapturePoint(centerCp);
    mod.EnableGameModeObjective(centerCp, false);
    mod.EnableGameModeObjective(centerSector, false);

    await mod.Wait(1);

    buildCpDistanceMatrix(capturePoints);
    centerPosition = mod.GetObjectPosition(centerCp as unknown as mod.Object);

    previewIcon = mod.GetWorldIcon(PREVIEW_ICON_ID);
    mod.SetWorldIconImage(previewIcon, mod.WorldIconImages.Triangle);
    mod.SetWorldIconColor(previewIcon, mod.CreateVector(1, 0.75, 0.2));
    hideNextHillPreview();

    // Smoke test: prove ObjId 400 + enable/move work, then hide before live play.
    movePreviewIconTo(centerPosition);
    mod.EnableWorldIconImage(previewIcon, true);
    await mod.Wait(5);
    hideNextHillPreview();

    // Always open on the center flag; it never reappears after the first handoff.
    centerActive = true;
    activeCpIndex = -1;
    nextRotateAt = ROTATE_SECONDS;
    await activateCenter();

    mod.SetGameModeScore(mod.GetTeam(1), 0);
    mod.SetGameModeScore(mod.GetTeam(2), 0);
    mod.SetGameModeTargetScore(TARGET_SCORE);

    mod.SetScoreboardType((mod.ScoreboardType.CustomTwoTeams));
    setupScoreboardColumns();
    mod.SetScoreboardHeader(mod.Message(mod.stringkeys.score, 0), mod.Message(mod.stringkeys.score, 0));

    // Do not gate on GetMatchTimeRemaining — it can stay 0 in custom layouts.
    while (true) {
        await mod.Wait(1);
        elapsedSeconds++;

        updateNextHillPreview();
        if (previewHideAt >= 0 && elapsedSeconds >= previewHideAt) {
            hideNextHillPreview();
        }

        if (nextRotateAt >= 0 && elapsedSeconds >= nextRotateAt) {
            nextRotateAt = elapsedSeconds + ROTATE_SECONDS;

            if (centerActive) {
                const newIndex = previewedNextIndex >= 0
                    ? previewedNextIndex
                    : pickNextCpIndexFromPosition(centerPosition);
                lingerNextHillPreview(newIndex);
                deactivateCenter();
                centerActive = false;
                activeCpIndex = newIndex;
                recordRecentCp(newIndex);
                await activatePair(newIndex, capturePoints, sectors);
            } else {
                const oldIndex = activeCpIndex;
                const newIndex = previewedNextIndex >= 0
                    ? previewedNextIndex
                    : pickNextCpIndex();
                if (newIndex === oldIndex) {
                    hideNextHillPreview();
                    continue;
                }
                lingerNextHillPreview(newIndex);
                deactivatePair(oldIndex, capturePoints, sectors);
                await mod.Wait(1);
                activeCpIndex = newIndex;
                recordRecentCp(newIndex);
                await activatePair(newIndex, capturePoints, sectors);
            }
        }

        updateTeamScores();
        awardHillPlayerScores();
        updateScoreBoardTotal();
        if (await tryEndMatchByScore()) {
            break;
        }
    }
}

function configureCapturePoint(cp: mod.CapturePoint) {
    mod.SetCapturePointCapturingTime(cp, 10);
    mod.SetCapturePointNeutralizationTime(cp, 10);
    mod.SetMaxCaptureMultiplier(cp, 1);
}

async function activateCenter() {
    // Sector must be on or the CP never appears in-world / on the HUD.
    mod.EnableGameModeObjective(centerSector, true);
    await mod.Wait(1);
    mod.EnableGameModeObjective(centerCp, true);
}

function deactivateCenter() {
    mod.EnableGameModeObjective(centerCp, false);
    mod.EnableGameModeObjective(centerSector, false);
}

function getUpcomingCpIndex(): number {
    if (centerActive) {
        return pickNextCpIndexFromPosition(centerPosition);
    }
    return pickNextCpIndex();
}

function hideNextHillPreview() {
    mod.EnableWorldIconImage(previewIcon, false);
    mod.EnableWorldIconText(previewIcon, false);
    previewVisible = false;
    previewedNextIndex = -1;
    previewHideAt = -1;
}

/** Keep marker lit at the new hill for PREVIEW_LINGER_SECONDS after rotation. */
function lingerNextHillPreview(index: number) {
    if (index >= 0 && index < CP_COUNT) {
        movePreviewIconTo(cpPositions[index]);
    }
    previewedNextIndex = -1;
    previewVisible = true;
    previewHideAt = elapsedSeconds + PREVIEW_LINGER_SECONDS;
    mod.SetWorldIconImage(previewIcon, mod.WorldIconImages.Triangle);
    mod.EnableWorldIconImage(previewIcon, true);
    mod.EnableWorldIconText(previewIcon, false);
}

function movePreviewIconTo(position: mod.Vector) {
    const lifted = mod.CreateVector(
        mod.XComponentOf(position),
        mod.YComponentOf(position) + PREVIEW_ICON_HEIGHT,
        mod.ZComponentOf(position)
    );
    const transform = mod.CreateTransform(lifted, mod.CreateVector(0, 0, 0));
    mod.SetObjectTransform(previewIcon, transform);
}

function showNextHillPreview(index: number) {
    if (index < 0 || index >= CP_COUNT) {
        return;
    }
    movePreviewIconTo(cpPositions[index]);
    mod.SetWorldIconImage(previewIcon, mod.WorldIconImages.Triangle);
    mod.EnableWorldIconImage(previewIcon, true);
    mod.EnableWorldIconText(previewIcon, false);
    previewedNextIndex = index;
    previewVisible = true;
}

/** Show next-hill marker once we are within PREVIEW_SECONDS of rotation. */
function updateNextHillPreview() {
    if (previewVisible) {
        return;
    }
    if (nextRotateAt < 0) {
        return;
    }
    if (nextRotateAt - elapsedSeconds > PREVIEW_SECONDS) {
        return;
    }
    const upcoming = getUpcomingCpIndex();
    if (upcoming < 0 || (!centerActive && upcoming === activeCpIndex)) {
        return;
    }
    showNextHillPreview(upcoming);
}

export function OnPlayerJoinGame(eventPlayer: mod.Player) {
    if (!mod.IsPlayerValid(eventPlayer)) {
        return;
    }
    assignBalancedRandomTeam(eventPlayer);
    initPlayerStats(eventPlayer);
    updatePlayerScoreboard(eventPlayer);
}

/** Put joiner on the smaller team; on a tie pick 1 or 2 at random. */
function assignBalancedRandomTeam(player: mod.Player) {
    const team1Count = countPlayersOnTeam(1, player);
    const team2Count = countPlayersOnTeam(2, player);

    let teamId = 1;
    if (team1Count < team2Count) {
        teamId = 1;
    } else if (team2Count < team1Count) {
        teamId = 2;
    } else {
        let pool = mod.EmptyArray();
        pool = mod.AppendToArray(pool, 1);
        pool = mod.AppendToArray(pool, 2);
        teamId = mod.RandomValueInArray(pool) as number;
    }

    mod.SetTeam(player, mod.GetTeam(teamId));
}

/** Count valid players on a team, excluding the joining player (still defaulted). */
function countPlayersOnTeam(teamId: number, excludePlayer: mod.Player): number {
    let count = 0;
    const players = mod.AllPlayers();
    const n = mod.CountOf(players);
    const excludeId = mod.GetObjId(excludePlayer);
    for (var i = 0; i < n; i++) {
        const p = mod.ValueInArray(players, i) as mod.Player;
        if (!mod.IsPlayerValid(p)) {
            continue;
        }
        if (mod.GetObjId(p) === excludeId) {
            continue;
        }
        if (mod.Equals(mod.GetTeam(p), mod.GetTeam(teamId))) {
            count++;
        }
    }
    return count;
}

export function OnPlayerDeployed(eventPlayer: mod.Player) {
    if (!mod.IsPlayerValid(eventPlayer)) {
        return;
    }
    initPlayerStats(eventPlayer);
    updatePlayerScoreboard(eventPlayer);
}

export function OnPlayerEarnedKill(
    eventPlayer: mod.Player,
    eventOtherPlayer: mod.Player,
    _eventDeathType: mod.DeathType,
    _eventWeaponUnlock: mod.WeaponUnlock
) {
    if (mod.IsPlayerValid(eventPlayer)) {
        const id = mod.GetObjId(eventPlayer);
        playerKills[id] = (playerKills[id] ? playerKills[id] : 0) + 1;
        addPlayerScore(eventPlayer, SCORE_KILL);
    }
    updatePlayerScoreboard(eventOtherPlayer);
}

export function OnPlayerDied(
    eventPlayer: mod.Player,
    _eventOtherPlayer: mod.Player,
    _eventDeathType: mod.DeathType,
    _eventWeaponUnlock: mod.WeaponUnlock
) {
    if (mod.IsPlayerValid(eventPlayer)) {
        const id = mod.GetObjId(eventPlayer);
        playerDeaths[id] = (playerDeaths[id] ? playerDeaths[id] : 0) + 1;
    }
    updatePlayerScoreboard(eventPlayer);
}

export function OnPlayerEarnedKillAssist(eventPlayer: mod.Player, _eventOtherPlayer: mod.Player) {
    if (!mod.IsPlayerValid(eventPlayer)) {
        return;
    }
    const id = mod.GetObjId(eventPlayer);
    playerAssists[id] = (playerAssists[id] ? playerAssists[id] : 0) + 1;
    addPlayerScore(eventPlayer, SCORE_ASSIST);
}

/** Reviver is eventOtherPlayer; revived player is eventPlayer. */
export function OnRevived(eventPlayer: mod.Player, eventOtherPlayer: mod.Player) {
    if (!mod.IsPlayerValid(eventOtherPlayer)) {
        return;
    }
    addPlayerScore(eventOtherPlayer, SCORE_REVIVE);
    updatePlayerScoreboard(eventPlayer);
}

function initPlayerStats(player: mod.Player) {
    const id = mod.GetObjId(player);
    if (!playerAssists[id]) {
        playerAssists[id] = 0;
    }
    if (!playerScores[id]) {
        playerScores[id] = 0;
    }
    if (!playerKills[id]) {
        playerKills[id] = 0;
    }
    if (!playerDeaths[id]) {
        playerDeaths[id] = 0;
    }
}

function addPlayerScore(player: mod.Player, amount: number) {
    if (!mod.IsPlayerValid(player) || amount <= 0) {
        return;
    }
    const id = mod.GetObjId(player);
    playerScores[id] = (playerScores[id] ? playerScores[id] : 0) + amount;
    updatePlayerScoreboard(player);
}

function updatePlayerScoreboard(player: mod.Player) {
    if (!mod.IsPlayerValid(player)) {
        return;
    }
    const id = mod.GetObjId(player);
    const score = playerScores[id] ? playerScores[id] : 0;
    const kills = playerKills[id] ? playerKills[id] : 0;
    const deaths = playerDeaths[id] ? playerDeaths[id] : 0;
    const assists = playerAssists[id] ? playerAssists[id] : 0;
    mod.SetScoreboardPlayerValues(player, score, kills, deaths, assists);
}

/** Re-push custom columns for everyone — column/header rebuilds can wipe values. */
function refreshAllPlayerScoreboards() {
    const players = mod.AllPlayers();
    const n = mod.CountOf(players);
    for (var i = 0; i < n; i++) {
        const p = mod.ValueInArray(players, i) as mod.Player;
        updatePlayerScoreboard(p);
    }
}

/** Full custom board layout + all player rows (needed before/at end screen). */
function reapplyScoreboard() {
    const score1 = mod.GetGameModeScore(mod.GetTeam(1));
    const score2 = mod.GetGameModeScore(mod.GetTeam(2));
    mod.SetScoreboardType(mod.ScoreboardType.CustomTwoTeams);
    setupScoreboardColumns();
    mod.SetScoreboardHeader(mod.Message(mod.stringkeys.score, score1), mod.Message(mod.stringkeys.score, score2));
    refreshAllPlayerScoreboards();
}

export async function OnGameModeEnding() {
    reapplyScoreboard();
    await mod.Wait(0.5);
    reapplyScoreboard();
}

/** Rush-style: enable sector, wait, then enable its capture point. */
async function activatePair(
    index: number,
    capturePoints: mod.CapturePoint[],
    sectors: mod.Sector[]
) {
    if (index < 0 || index >= CP_COUNT) {
        return;
    }
    mod.EnableGameModeObjective(sectors[index], true);
    await mod.Wait(1);
    mod.EnableGameModeObjective(capturePoints[index], true);
}

function deactivatePair(
    index: number,
    capturePoints: mod.CapturePoint[],
    sectors: mod.Sector[]
) {
    if (index < 0 || index >= CP_COUNT) {
        return;
    }
    mod.EnableGameModeObjective(capturePoints[index], false);
    mod.EnableGameModeObjective(sectors[index], false);
}

function setupScoreboardColumns() {
    // Column titles need literal label strings in strings.json (e.g. "Kills"), not "{}".
    mod.SetScoreboardColumnNames(
        mod.Message(mod.stringkeys.score),
        mod.Message(mod.stringkeys.kills),
        mod.Message(mod.stringkeys.deaths),
        mod.Message(mod.stringkeys.assists)
    );
    mod.SetScoreboardColumnWidths(35, 25, 20, 20);
    mod.SetScoreboardSorting(0);
}

function buildCpDistanceMatrix(capturePoints: mod.CapturePoint[]) {
    for (var i = 0; i < CP_COUNT; i++) {
        cpPositions[i] = mod.GetObjectPosition(capturePoints[i] as unknown as mod.Object);
        cpDistances[i] = [];
    }
    for (var a = 0; a < CP_COUNT; a++) {
        for (var b = 0; b < CP_COUNT; b++) {
            if (a === b) {
                cpDistances[a][b] = 0;
            } else {
                cpDistances[a][b] = mod.DistanceBetween(cpPositions[a], cpPositions[b]);
            }
        }
    }
}

function isRecentCp(index: number): boolean {
    for (var i = 0; i < recentCpCount; i++) {
        if (recentCpSlots[i] === index) {
            return true;
        }
    }
    return false;
}

function recordRecentCp(index: number) {
    if (recentCpCount < RECENT_CP_MAX) {
        recentCpSlots[recentCpCount] = index;
        recentCpCount = recentCpCount + 1;
        return;
    }
    for (var i = 0; i < RECENT_CP_MAX - 1; i++) {
        recentCpSlots[i] = recentCpSlots[i + 1];
    }
    recentCpSlots[RECENT_CP_MAX - 1] = index;
}

function collectRotatingCandidates(excludeIndex: number): number[] {
    const candidates: number[] = [];
    for (var i = 0; i < CP_COUNT; i++) {
        if (i !== excludeIndex && !isRecentCp(i)) {
            candidates.push(i);
        }
    }
    if (candidates.length === 0) {
        // Prefer oldest recent entries first (slots[0] is oldest) over a full reopen.
        for (var r = 0; r < recentCpCount; r++) {
            const oldest = recentCpSlots[r];
            if (oldest !== excludeIndex && oldest >= 0) {
                candidates.push(oldest);
            }
        }
        if (candidates.length === 0) {
            for (var j = 0; j < CP_COUNT; j++) {
                if (j !== excludeIndex) {
                    candidates.push(j);
                }
            }
        }
    }
    return candidates;
}

function sortCandidatesByDistance(
    candidates: number[],
    distanceFor: (index: number) => number
): void {
    for (var a = 0; a < candidates.length; a++) {
        for (var b = a + 1; b < candidates.length; b++) {
            if (distanceFor(candidates[b]) < distanceFor(candidates[a])) {
                const tmp = candidates[a];
                candidates[a] = candidates[b];
                candidates[b] = tmp;
            }
        }
    }
}

/**
 * Random pick among 2nd–4th nearest (skip closest). Already sorted by distance.
 * If only one candidate remains, use it; if fewer than four, use whatever ranks exist after #1.
 */
function pickRandomNearest(candidates: number[]): number {
    if (candidates.length === 0) {
        return activeCpIndex >= 0 ? activeCpIndex : 0;
    }
    if (candidates.length === 1) {
        return candidates[0];
    }
    const end = candidates.length < 4 ? candidates.length : 4;
    let pool = mod.EmptyArray();
    for (var i = 1; i < end; i++) {
        pool = mod.AppendToArray(pool, candidates[i]);
    }
    return mod.RandomValueInArray(pool) as number;
}

/** First handoff off the center opener: random among 2nd–4th nearest to center (not in last three). */
function pickNextCpIndexFromPosition(fromPosition: mod.Vector): number {
    const candidates = collectRotatingCandidates(-1);
    sortCandidatesByDistance(candidates, (index) =>
        mod.DistanceBetween(fromPosition, cpPositions[index])
    );
    return pickRandomNearest(candidates);
}

/** Exclude last-three history; among the rest pick random of 2nd–4th nearest to current. */
function pickNextCpIndex(): number {
    const candidates = collectRotatingCandidates(activeCpIndex);

    if (candidates.length === 0) {
        return activeCpIndex >= 0 ? activeCpIndex : 0;
    }

    const from = activeCpIndex;
    const row = cpDistances[from];
    if (!row) {
        return candidates[0];
    }
    sortCandidatesByDistance(candidates, (index) => row[index]);
    return pickRandomNearest(candidates);
}

function updateScoreBoardTotal() {
    const score1 = mod.GetGameModeScore(mod.GetTeam(1));
    const score2 = mod.GetGameModeScore(mod.GetTeam(2));
    // Header only mid-match — re-running columns every tick can wipe the other team's rows.
    mod.SetScoreboardHeader(mod.Message(mod.stringkeys.score, score1), mod.Message(mod.stringkeys.score, score2));
    refreshAllPlayerScoreboards();
}

function getSecondsPerPoint(pointsHeld: number): number {
    return pointsHeld === 1 ? 10 : 0;
}

/** First team to TARGET_SCORE wins; ends the match. */
async function tryEndMatchByScore(): Promise<boolean> {
    const score1 = mod.GetGameModeScore(mod.GetTeam(1));
    const score2 = mod.GetGameModeScore(mod.GetTeam(2));
    if (score1 >= TARGET_SCORE) {
        await finalizeScoreboardThenEnd(mod.GetTeam(1));
        return true;
    }
    if (score2 >= TARGET_SCORE) {
        await finalizeScoreboardThenEnd(mod.GetTeam(2));
        return true;
    }
    return false;
}

/** Push both teams' rows, let them settle, then end — end screen otherwise shows enemy 0s. */
async function finalizeScoreboardThenEnd(winningTeam: mod.Team) {
    reapplyScoreboard();
    await mod.Wait(1);
    reapplyScoreboard();
    mod.EndGameMode(winningTeam);
}

function getActiveCapturePoint(): mod.CapturePoint | null {
    if (centerActive) {
        return centerCp;
    }
    if (activeCpIndex >= 0) {
        return mod.GetCapturePoint(CP_ID_BASE + activeCpIndex);
    }
    return null;
}

/** +SCORE_HILL_PER_SECOND for each player standing on the owned hardpoint. */
function awardHillPlayerScores() {
    const cp = getActiveCapturePoint();
    if (!cp) {
        return;
    }
    const owner = mod.GetCurrentOwnerTeam(cp);
    const team1 = mod.GetTeam(1);
    const team2 = mod.GetTeam(2);
    if (!mod.Equals(owner, team1) && !mod.Equals(owner, team2)) {
        return;
    }

    const onPoint = mod.GetPlayersOnPoint(cp);
    const n = mod.CountOf(onPoint);
    for (var i = 0; i < n; i++) {
        const p = mod.ValueInArray(onPoint, i) as mod.Player;
        if (!mod.IsPlayerValid(p)) {
            continue;
        }
        if (mod.Equals(mod.GetTeam(p), owner)) {
            addPlayerScore(p, SCORE_HILL_PER_SECOND);
        }
    }
}

function updateTeamScores() {
    let team1PointsHeld = 0;
    let team2PointsHeld = 0;

    const cp = getActiveCapturePoint();
    if (cp) {
        const owner = mod.GetCurrentOwnerTeam(cp);
        if (mod.Equals(owner, mod.GetTeam(1))) {
            team1PointsHeld = 1;
        } else if (mod.Equals(owner, mod.GetTeam(2))) {
            team2PointsHeld = 1;
        }
    }

    team1ScoreTimer++;
    team2ScoreTimer++;

    const team1rate = getSecondsPerPoint(team1PointsHeld);
    const team2rate = getSecondsPerPoint(team2PointsHeld);

    if (team1ScoreTimer >= team1rate && team1rate > 0) {
        team1ScoreTimer = 0;
        const currentScore = mod.GetGameModeScore(mod.GetTeam(1));
        const newScore = currentScore + 1;
        mod.SetGameModeScore(mod.GetTeam(1), newScore);
    }
    if (team2ScoreTimer >= team2rate && team2rate > 0) {
        team2ScoreTimer = 0;
        const currentScore = mod.GetGameModeScore(mod.GetTeam(2));
        const newScore = currentScore + 1;
        mod.SetGameModeScore(mod.GetTeam(2), newScore);
    }
}
