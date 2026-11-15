let team1ScoreTimer = 0;
let team2ScoreTimer = 0;

export async function OnGameModeStarted() {

    const sector = mod.GetSector(300);
    mod.EnableGameModeObjective(sector, true);

    const capturePoints = [];
    for (var i = 0; i < 6; i++) {
        const cp = mod.GetCapturePoint(200 + i);
        capturePoints.push(cp);
        mod.EnableCapturePointDeploying(capturePoints[i], true);
        mod.EnableGameModeObjective(capturePoints[i], true);
        mod.SetCapturePointCapturingTime(capturePoints[i], 10);
        mod.SetCapturePointNeutralizationTime(capturePoints[i], 10);
        mod.SetMaxCaptureMultiplier(capturePoints[i], 1);
    }

    // games scores
    mod.SetGameModeScore(mod.GetTeam(1), 0);
    mod.SetGameModeScore(mod.GetTeam(2), 0);


    mod.SetScoreboardType((mod.ScoreboardType.CustomTwoTeams));

    mod.SetScoreboardHeader(mod.Message(mod.stringkeys.score, 0), mod.Message(mod.stringkeys.score, 0));

    while (mod.GetMatchTimeRemaining() > 0) {
        await mod.Wait(1);
        updateTeamScores();
        updateScoreBoardTotal();

    }
}

function updateScoreBoardTotal() {
    const score1 = mod.GetGameModeScore(mod.GetTeam(1));
    const score2 = mod.GetGameModeScore(mod.GetTeam(2));
    mod.SetScoreboardHeader(mod.Message(mod.stringkeys.score, score1), mod.Message(mod.stringkeys.score, score2));
}

function getSecondsPerPoint(pointsHeld: number): number {
    if (pointsHeld === 3) {
        return 1;
    } else if (pointsHeld === 2) {
        return 5;
    } else if (pointsHeld === 1) {
        return 10;
    }
    return 0;
}

function updateTeamScores() {
    let team1PointsHeld = 0;
    let team2PointsHeld = 0;
    const capturePointOwners = [];
    for (var i = 0; i < 6; i++) {
        capturePointOwners[i] = mod.GetCurrentOwnerTeam(mod.GetCapturePoint(i + 200));
        if (mod.Equals(capturePointOwners[i], mod.GetTeam(1))) {
            team1PointsHeld++;
        } else if (mod.Equals(capturePointOwners[i], mod.GetTeam(2))) {
            team2PointsHeld++;
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

