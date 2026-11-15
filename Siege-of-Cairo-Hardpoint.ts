const CP_COUNT = 10; // indices 0..9 → CPs 200-209 / sectors 300-309
const CP_ID_BASE = 200;
const SECTOR_ID_BASE = 300;
const CENTER_CP_ID = 250;
const CENTER_SECTOR_ID = 350;
const ROTATE_SECONDS = 90;
const MATCH_TIME_SECONDS = 20 * 60;

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

/** Assist counts keyed by mod.GetObjId(player). Engine has no GetPlayerAssists. */
const playerAssists: number[] = [];

/** Pairwise distances between rotating CPs (built once at match start). */
const cpDistances: number[][] = [];
/** World positions of rotating CPs (for first handoff from center). */
const cpPositions: mod.Vector[] = [];
/** Oldest → newest indices of recently active rotating CPs (max 5). */
const recentCpIndices: number[] = [];

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

    // Always open on the center flag; it never reappears after the first handoff.
    centerActive = true;
    activeCpIndex = -1;
    nextRotateAt = ROTATE_SECONDS;
    await activateCenter();

    mod.SetGameModeScore(mod.GetTeam(1), 0);
    mod.SetGameModeScore(mod.GetTeam(2), 0);

    mod.SetScoreboardType((mod.ScoreboardType.CustomTwoTeams));
    setupScoreboardColumns();
    mod.SetScoreboardHeader(mod.Message(mod.stringkeys.score, 0), mod.Message(mod.stringkeys.score, 0));

    // Do not gate on GetMatchTimeRemaining — it can stay 0 in custom layouts.
    while (true) {
        await mod.Wait(1);
        elapsedSeconds++;

        if (nextRotateAt >= 0 && elapsedSeconds >= nextRotateAt) {
            nextRotateAt = elapsedSeconds + ROTATE_SECONDS;

            if (centerActive) {
                deactivateCenter();
                centerActive = false;
                const newIndex = pickNextCpIndexFromPosition(centerPosition);
                activeCpIndex = newIndex;
                recordRecentCp(newIndex);
                await activatePair(newIndex, capturePoints, sectors);
            } else {
                const oldIndex = activeCpIndex;
                const newIndex = pickNextCpIndex();
                if (newIndex === oldIndex) {
                    continue;
                }
                deactivatePair(oldIndex, capturePoints, sectors);
                await mod.Wait(1);
                activeCpIndex = newIndex;
                recordRecentCp(newIndex);
                await activatePair(newIndex, capturePoints, sectors);
            }
        }

        updateTeamScores();
        updateScoreBoardTotal();
    }
}

function configureCapturePoint(cp: mod.CapturePoint) {
    mod.SetCapturePointCapturingTime(cp, 10);
    mod.SetCapturePointNeutralizationTime(cp, 10);
    mod.SetMaxCaptureMultiplier(cp, 1);
}

async function activateCenter() {
    mod.EnableGameModeObjective(centerSector, true);
    await mod.Wait(1);
    mod.EnableGameModeObjective(centerCp, true);
}

function deactivateCenter() {
    mod.EnableGameModeObjective(centerCp, false);
    mod.EnableGameModeObjective(centerSector, false);
}

export function OnPlayerJoinGame(eventPlayer: mod.Player) {
    if (!mod.IsPlayerValid(eventPlayer)) {
        return;
    }
    assignBalancedRandomTeam(eventPlayer);
    playerAssists[mod.GetObjId(eventPlayer)] = 0;
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
    const id = mod.GetObjId(eventPlayer);
    if (!playerAssists[id]) {
        playerAssists[id] = 0;
    }
    updatePlayerScoreboard(eventPlayer);
}

export function OnPlayerEarnedKill(
    eventPlayer: mod.Player,
    eventOtherPlayer: mod.Player,
    _eventDeathType: mod.DeathType,
    _eventWeaponUnlock: mod.WeaponUnlock
) {
    updatePlayerScoreboard(eventPlayer);
    updatePlayerScoreboard(eventOtherPlayer);
}

export function OnPlayerDied(
    eventPlayer: mod.Player,
    _eventOtherPlayer: mod.Player,
    _eventDeathType: mod.DeathType,
    _eventWeaponUnlock: mod.WeaponUnlock
) {
    updatePlayerScoreboard(eventPlayer);
}

export function OnPlayerEarnedKillAssist(eventPlayer: mod.Player, _eventOtherPlayer: mod.Player) {
    if (!mod.IsPlayerValid(eventPlayer)) {
        return;
    }
    const id = mod.GetObjId(eventPlayer);
    playerAssists[id] = (playerAssists[id] ? playerAssists[id] : 0) + 1;
    updatePlayerScoreboard(eventPlayer);
}

function updatePlayerScoreboard(player: mod.Player) {
    if (!mod.IsPlayerValid(player)) {
        return;
    }
    const id = mod.GetObjId(player);
    const assists = playerAssists[id] ? playerAssists[id] : 0;
    mod.SetScoreboardPlayerValues(
        player,
        mod.GetPlayerKills(player),
        mod.GetPlayerDeaths(player),
        assists
    );
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
        mod.Message(mod.stringkeys.kills),
        mod.Message(mod.stringkeys.deaths),
        mod.Message(mod.stringkeys.assists)
    );
    mod.SetScoreboardColumnWidths(40, 30, 30);
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
    for (var i = 0; i < recentCpIndices.length; i++) {
        if (recentCpIndices[i] === index) {
            return true;
        }
    }
    return false;
}

function recordRecentCp(index: number) {
    recentCpIndices.push(index);
    while (recentCpIndices.length > 5) {
        recentCpIndices.shift();
    }
}

function collectRotatingCandidates(excludeIndex: number): number[] {
    const candidates: number[] = [];
    for (var i = 0; i < CP_COUNT; i++) {
        if (i !== excludeIndex && !isRecentCp(i)) {
            candidates.push(i);
        }
    }
    if (candidates.length === 0) {
        for (var j = 0; j < CP_COUNT; j++) {
            if (j !== excludeIndex) {
                candidates.push(j);
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

function pickSecondNearest(candidates: number[]): number {
    if (candidates.length === 0) {
        return activeCpIndex >= 0 ? activeCpIndex : 0;
    }
    if (candidates.length === 1) {
        return candidates[0];
    }
    return candidates[1];
}

/** First handoff off the center opener: second-nearest rotating CP to center (not in last five). */
function pickNextCpIndexFromPosition(fromPosition: mod.Vector): number {
    const candidates = collectRotatingCandidates(-1);
    sortCandidatesByDistance(candidates, (index) =>
        mod.DistanceBetween(fromPosition, cpPositions[index])
    );
    return pickSecondNearest(candidates);
}

/** Exclude last-three history; among the rest pick second-nearest to current. */
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
    return pickSecondNearest(candidates);
}

function updateScoreBoardTotal() {
    const score1 = mod.GetGameModeScore(mod.GetTeam(1));
    const score2 = mod.GetGameModeScore(mod.GetTeam(2));
    // Re-apply columns — some layouts clear them when the header is rewritten.
    setupScoreboardColumns();
    mod.SetScoreboardHeader(mod.Message(mod.stringkeys.score, score1), mod.Message(mod.stringkeys.score, score2));
}

function getSecondsPerPoint(pointsHeld: number): number {
    return pointsHeld === 1 ? 10 : 0;
}

function updateTeamScores() {
    let team1PointsHeld = 0;
    let team2PointsHeld = 0;

    if (centerActive || activeCpIndex >= 0) {
        const owner = centerActive
            ? mod.GetCurrentOwnerTeam(centerCp)
            : mod.GetCurrentOwnerTeam(mod.GetCapturePoint(CP_ID_BASE + activeCpIndex));
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
