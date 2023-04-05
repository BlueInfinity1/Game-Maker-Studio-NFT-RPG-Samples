const AWS = require('aws-sdk');
AWS.config.update({region: "us-west-1"});
const documentClient = new AWS.DynamoDB.DocumentClient({region: "us-west-1"});

//limit variables for the current version of the game
const dailyChestTokenLimit = 1000;
const maxXp = 263958; // how much is needed for lvl 40, which is the current level cap
const petLevelCap = 40;
const maxSkillLevelSum = 39; //NOTE: can be higher if there are NFTs with skill booster stars
const maxItemRank = 3;
const maxGold = 100000;
const maxKibbles = 100000;
const totalNormalMissions = 30;
const totalChallengeMissions = 30;

//DEV
const playerTableName = "WackyDungeonPlayers";
const generalTableName = "WackyDungeonGeneralTable"; //this table contains ubiquitous data required in both dev and prod versions
const alchemyAPIKey = "_vDGebu4wFiRF3sKkb-_u5JbapUjnp1U"; //mock-key
const alchemyAPIUrl = "https://eth-rinkeby.alchemyapi.io/v2/" + alchemyAPIKey;
const privateKey = "138dedfeedd075afc6123d1c19d5f5227873b8a3478381633fa9933eb408d705"; //mock-key

//PROD ENV VARIABLES HERE (REMOVED)

//BLOCKCHAIN-RELATED VARIABLES
const { createAlchemyWeb3 } = require("@alch/alchemy-web3");
const tokenContractJSON = require("./ABI/XtokenABI.json");
const tokenContractAddress = "0x71ed54ccf010e867f8c577e447dddb77a0f6c658"; //contract of XTOKEN
const NFTContractJSON = require("./ABI/NFTContractABI.json");
const NFTContractAddress = "0xD6e12f46e698589aA52FAdD40EC49bFEA90aF030";
const web3 = createAlchemyWeb3(alchemyAPIUrl);
const walletAddress = "0xD6386f41BC951fdCAe1ba25994f0a70fc6F78afD"; //testing only
const alchemyProvider = new ethers.providers.AlchemyProvider(network="rinkeby", alchemyAPIKey);
const signer = new ethers.Wallet(privateKey, alchemyProvider);
const tokenContract = new web3.eth.Contract(tokenContractJSON,tokenContractAddress);
new ethers.Contract(tokenAddress, tokenContractJSON, signer);

let seed = getCurrentEpochTime() - 1641225274;
let rand = require('random-seed').create(seed);

let normalClearRewards = {};
let challengeClearRewards = {};

let playerId;
let tokenDropProbabilityBoostForTimedChest = 0; //use these when opening timed chests
let tokenGainBoostForTimedChest = 0;

exports.handler = async (event) => 
{
    initializeClearRewards();
    
    const body = JSON.parse(event.body);

    const opCode = body.op;
    const accessToken = body.accessToken; //NOTE: To perform any operation, we must have an access token that matches the token stored in the database for a specific player.
    //This token is earned through a legitimate login process.
    playerId = body.playerId; //NOTE: This is the NFT token id (0 to 9999 initially)
    const walletAddress = body.walletId;
    let missionId = body.missionId; 
    let saveData = body.saveData;
    
    const NFTContract = new web3.eth.Contract(NFTContractJSON,NFTContractAddress);
    const tokenContract = new web3.eth.Contract(tokenContractJSON,tokenContractAddress);

    let NFTBalance = await NFTContract.methods.balanceOf(walletAddress).call();
    let walletNFTs = new Array[NFTBalance];

    for (let i = 0; i < NFTBalance; i++) //TODO: Build a JSON object with all the metadata of the NFT
        walletNFTs[i] = await NFTContract.methods.tokenOfOwnerByIndex(walletAddress, i).call();
    
    let playerRecord;
    if (playerId != undefined)
    {
        try {
            playerRecord = await getPlayerData(playerId); 
        }
        catch (e) {
            console.log("Error fetching player data: " + e);
            return sendResponse(500, {status: "ERROR", error: "Could not fetch player data " + e});
        }
    }
    else
    return sendResponse(500, {status: "ERROR", error: "Player not found"});
    
    if (playerRecord.Item.accessToken != accessToken)
    {
        //Log unauthorized access so that we can view it via CloudWatch
        console.log("UNAUTHORIZED ACCESS: Access token of Player " + playerId + " is " + playerRecord.Item.accessToken + ", we were given " + accessToken);
        return sendResponse(401, {status: "ERROR", error: "Access Denied"}); //unauthorized access
    }

    switch (opCode)
    {   
        //NOTE: Some cases have been removed, since this is just a sample
        
        case (101): //Open a timed chest which can be opened only once per day
        {
            let currentTime = getCurrentEpochTime();
            let yesterdayTimeLimit = currentTime - (currentTime % 86400);
            
            if (playerRecord.Item.lastTimedChestOpenTime <= yesterdayTimeLimit) //check whether the previous opening was done yesterday
            {
                await updatePlayerData(playerId, "set lastTimedChestOpenTime = :ltcot", {":ltcot": currentTime});
                tokenGainBoostForTimedChest = 40;
                missionId = playerRecord.Item.lastNormalMissionCleared; //we will update this regardless of whether we get tokens or not
            }
            else
            {
                //The client should never allow sending a timed chest request if the day has not changed after we opened the previous
                //chest, so if we reach here, it's likely that the client has been tinkered with
                return (sendResponse(200, {status: "OK"})); 
            }
        } //NOTE: We'll fall through to normal chest opening if the timed chest can be opened
        
        case (102): //Open chest for tokens
        {
            let gameData = await getGameData();
            let random = getRandomNumber();
            
            let playerFlagged = playerRecord.Item.flagged;
            let currentMissionId = missionId;
            currentMissionId = missionId % 1000;
            if (currentMissionId > totalNormalMissions || missionId > 2000) //this shouldn't happen normally during the course of the game
            {
                console.log("FLAG PLAYER: op 102 called with missionId " + missionId);
                playerFlagged = true;
                await updatePlayerData(playerId, "set flagged = :f", {":f": true});
            }
                
            let tokensToAdd = 0;
            let tokenDropProbability = 0.5 + currentMissionId*0.01 + tokenDropProbabilityBoostForTimedChest;
            
            if (random <= tokenDropProbability)
            {
                //first nullify dailyTokenCount to 0 before adding if lastTokenGotten time was yesterday based on epoch time
                let chestTokensGainedToday = playerRecord.Item.chestTokensGainedToday;                                
                let lastChestTokenGainTime = playerRecord.Item.lastChestTokenGainTime;
                let yesterdayTimeLimit = getCurrentEpochTime() - (getCurrentEpochTime() % 86400);
                
                console.log("Your last coin drop was at "+ lastChestTokenGainTime + " and today started at "+yesterdayTimeLimit);
                
                if (lastChestTokenGainTime != undefined)
                {
                    //The last token gain was during yesterday (server time)
                    if (lastChestTokenGainTime < yesterdayTimeLimit)
                    {
                        console.log ("This was yesterday (before "+ yesterdayTimeLimit +"), so your daily limit is replenished"); //TODO: This could be moved to the login phase
                        chestTokensGainedToday = 0;
                    }
                }
                                
                console.log("Player flagged: " + playerFlagged); //flagged players can't get more tokens until suspicions are cleared

                if (!playerFlagged && chestTokensGainedToday < dailyChestTokenLimit)
                {
                    tokensToAdd = Math.ceil(getRandomNumber()*(12 + tokenGainBoostForTimedChest)) + 1 + Math.ceil(tokenGainBoostForTimedChest/3 + currentMissionId);
                    if (chestTokensGainedToday + tokensToAdd >= dailyChestTokenLimit)
                    tokensToAdd = dailyChestTokenLimit - chestTokensGainedToday; //no more than the limit allowed
                    
                    await addChestTokens(playerId, tokensToAdd, chestTokensGainedToday, playerRecord.Item.totalTokens);
                    
                    let chestOpenTimes = playerRecord.Item.latestChestOpenTimes;
                    let openingCheckInterval = 120; //2 minutes

                    //Observe how many chests we've opened within the last 5 mins or so. 10+ chests should alarm us that cheating may be going on, so set flagged = true for this player.
                    if (chestOpenTimes[0] - chestOpenTimes[7] < openingCheckInterval) //8 chests opened in x minutes, may not be legit
                    {
                        console.log("FLAG PLAYER " + playerId + " for opening too many chests in a short time");
                        await updatePlayerData(playerId, "set flagged = :f", {":f": true});
                    }
                    
                    await updateLatestChestOpenTimes(chestOpenTimes);

                }
            }
            //return: Send back how many tokens you got to the client, and the client will inform that you got Wacky Tokens
            return sendResponse(200, {status: "OK", addedTokens: tokensToAdd});
        }
        
        case (200): //Get timed chest timer
        {
            let currentTime = getCurrentEpochTime();
            let yesterdayTimeLimit = currentTime - (currentTime % 86400);
            
            return sendResponse(200, {dailyChestGotten: playerRecord.Item.lastTimedChestOpenTime >= yesterdayTimeLimit});
        }
        
        case (400): //save game
        {
            //Here, we gather the update string to use with the database updating piece by piece, and do light cheating prevention checks along the way

            let flagPlayer = false;
            let flagReason = "none";

            let saveDataExpression = "set ";
            let saveDataParams = {};

            let dbSaveData = playerRecord.Item.saveData;

            if (saveData.xp != undefined) //BASIC DATA
            {
                //Do not save levels higher than levelCap, also cap gold and kibbles. Higher than max values should never be sent by the proper client, so we can be suspicious of cheating
                let xp = saveData.xp;

                if (xp < dbSaveData.xp) //xp can never get lower
                xp = dbSaveData.xp;

                if (xp > maxXp)
                {
                    xp = maxXp;
                    flagPlayer = true;
                    flagReason = "xp";
                }
                let gold = saveData.gold;
                if (gold > maxGold)
                {
                    gold = maxGold;
                    flagPlayer = true;
                    flagReason = "gold";
                }
                let kibbles = saveData.kibbles;
                if (kibbles > maxKibbles)
                {
                    kibbles = maxKibbles;
                    flagPlayer = true;
                    flagReason = "kibbles";
                }

                saveDataExpression += "saveData.xp = :xp, saveData.gold = :g, saveData.kibbles = :k,";
                saveDataParams[":xp"] = xp;
                saveDataParams[":g"] = gold;
                saveDataParams[":k"] = kibbles;
            }

            if (saveData.normalMissionList != undefined) //ALL MISSION DATA
            {
                let normalMissionList = saveData.normalMissionList;
                let challengeMissionList = saveData.challengeMissionList;

                if (normalMissionList.length >= totalNormalMissions || challengeMissionList.length >= totalChallengeMissions) 
                    return sendResponse(500, {status: "ERROR", message: "Save failed"});
                else //go through all the missions and set attributes to "true" where needed. Note that nothing can ever be set to "false", and attempt to do so should probably result in flagging
                {
                    for (let i = 0; i < totalNormalMissions; i++)
                    {
                        if (saveData.normalMissionList[i] != undefined)
                        {
                            //if an attribute is true, make sure we never change it in the update
                            if (dbSaveData.normalMissionList[i].cleared) 
                            normalMissionList[i].cleared = true;
                            else if (dbSaveData.normalMissionList[i].cleared && !normalMissionList[i].cleared) //a mission attribute is true in DB, but we're sending "false" value
                            {
                                flagPlayer = true;
                                flagReason = "normal mission clear reset";
                            }

                            if (dbSaveData.normalMissionList[i].unlocked) //don't lock an unlocked mission. If we try to do so, there's no penalty though, as this would only be harmful for the player
                            normalMissionList[i].unlocked = true;

                            if (dbSaveData.normalMissionList[i].rewardFetched) 
                            normalMissionList[i].rewardFetched = true;
                            else if (dbSaveData.normalMissionList[i].rewardFetched && !normalMissionList[i].rewardFetched) //a mission attribute is true in DB, but we're sending "false" value
                            {
                                flagPlayer = true;
                                flagReason = "normal mission reward fetch reset";
                            }
                        }
                        else
                            normalMissionList[i] = dbSaveData.normalMissionList[i];
                        
                    }

                    for (let i = 0; i < totalChallengeMissions; i++)
                    {
                        if (saveData.challengeMissionList[i] != undefined)
                        {
                            //if an attribute is true, make sure we never change it in the update
                            if (dbSaveData.challengeMissionList[i].cleared) 
                            challengeMissionList[i].cleared = true;
                            else if (dbSaveData.challengeMissionList[i].cleared && !challengeMissionList[i].cleared) //a mission attribute is true in DB, but we're sending "false" value
                            {
                                flagPlayer = true;
                                flagReason = "challenge mission clear reset";
                            }

                            if (dbSaveData.challengeMissionList[i].unlocked) //don't lock an unlocked mission. If we try to do so, there's no penalty though, as this would only be harmful for the player
                            challengeMissionList[i].unlocked = true;

                            if (dbSaveData.challengeMissionList[i].rewardFetched) 
                            challengeMissionList[i].rewardFetched = true;
                            else if (dbSaveData.challengeMissionList[i].rewardFetched && !challengeMissionList[i].rewardFetched) //a mission attribute is true in DB, but we're sending "false" value
                            {
                                flagPlayer = true;
                                flagReason = "challenge mission reward fetch reset";
                            }
                        }
                        else
                            challengeMissionList[i] = dbSaveData.challengeMissionList[i];
                    }
                }
                saveDataExpression += "saveData.normalMissionList = :nml, saveData.challengeMissionList = :cml,";
                saveDataParams[":nml"] = normalMissionList;
                saveDataParams[":cml"] = challengeMissionList;
                
            }

            if (saveData.allItems != undefined) //verify that item levels don't go over the max
            {
                let equippedItemList = saveData.allItems.equippedItemList;
                if (equippedItemList != undefined) //EQUIPPED ITEM DATA
                {
                    for (let i = 0; i < equippedItemList.length; i++)
                    {
                        if (equippedItemList[i].level > equippedItemList[i].rank*10 && equippedItemList[i].rank <= maxItemRank)
                        {
                            flagPlayer = true;
                            flagReason = "equipped item level too high: "+ equippedItemList[i].level;
                        }
                    }
                    saveDataExpression += "saveData.allItems.equippedItemList = :eil,";
                    saveDataParams[":eil"] = equippedItemList;
                }
                
                let itemList = saveData.allItems.itemList;
                if (itemList != undefined) //ITEM LIST DATA
                {
                    for (let i = 0; i < itemList.length; i++)
                    {
                        if (itemList[i].level > itemList[i].rank*10 && itemList[i].rank <= maxItemRank)
                        {
                            flagPlayer = true;
                            flagReason = "list item level too high: "+ itemList[i].level;
                        }
                    }
                }
                
                saveDataExpression += "saveData.allItems.itemList = :il,";
                saveDataParams[":il"] = itemList;
            }

            if (saveData.skillList != undefined)
            {
                let skillList = saveData.skillList;
                let skillLevelSum = 0;

                for (let i = 0; i < skillList.length; i++)
                    skillLevelSum += skillList[i].level;
                
                //TODO: Additional checks regarding whether we can have a skill at a certain hero level
                //TODO: Check if we can have an enemy skill level > 0 based on the enemy skill stats. E.g. 0 kills on all and level 1 is not possible without cheating
                //TODO: //if level < wackyBurstUnlockLevels[i] && equippedWackyBurst == wackyBursts[i], i.e. we've equipped a skill we shouldn't have access to yet
                if (skillLevelSum > maxSkillLevelSum)
                {
                    flagPlayer = true;
                    flagReason = "skill level sum too high: " + skillLevelSum;
                }

                saveDataExpression += "saveData.skillList = :sl,";
                saveDataParams[":sl"] = skillList;
            }

            if (saveData.petList != undefined)
            {
                let petList = saveData.petList;
                for (let i = 0; i < petList.length; i++)
                {
                    if (petList[i].level > petLevelCap)
                    {
                        flagPlayer = true;
                        flagReason = "pet level too high: " + petList[i].level;
                    }
                }
                saveDataExpression += "saveData.petList = :pl,";
                saveDataParams[":pl"] = petList;
            }

            if (saveDataExpression.endsWith(",")) //take off the extra ","
            saveDataExpression = saveDataExpression.substring(0, saveDataExpression.length-1);

            console.log("Saving data with expression: "+ saveDataExpression);

            if (flagPlayer)
            {
                console.log("Flagging player "+playerId + " with data: "+ JSON.stringify({timeStamp: getCurrentEpochTime(), reason: flagReason},2));
                await updatePlayerData(playerId, "set flagged = :f, flagData = :fd", {":f": true, 
                    ":fd": {timeStamp: getCurrentEpochTime(), reason: flagReason}});
            }
            else
                await updatePlayerData(playerId, saveDataExpression, saveDataParams);
            return sendResponse(200, {status: "OK"}); //the response to this isn't really checked, but I guess it's good for logging in case the save fails

        }
        
        case (401): //load game
        {
            return sendResponse(200, {status: saveData});
        }
    
        case (500): //logging in, should really be in websocket connection open
        {
            let NFTBalance = await NFTContract.methods.balanceOf(walletAddress).call();

            if (NFTBalance > 0)
            console.log("We own an NFT and can log in!");

            return sendResponse(200, {NFTsOwned: NFTBalance});
        }

    }
};

async function addChestTokens(playerId, amount, chestTokensGainedToday, currentTotalTokens)
{
    //NOTE: Earned tokens are always added to the database first, and the player will have to activate a separate operation to mint the tokens.             
    await updatePlayerTokenCounts(playerId, "set chestTokensGainedToday = :ctgt, lastChestTokenGainTime = :lctgt, totalTokens = :tt", 
        {
            ":ctgt": chestTokensGainedToday+amount,
            ":lctgt": getCurrentEpochTime(),
            ":tt": currentTotalTokens+amount
        });           
    
}

async function updatePlayerTokenCounts(playerId, updateExpression, attributeValues)
{
    //update the count on server first to keep track of these, although we can find the balances of the players based on wallet ids, and see the distribution of the tokens through other means as well    
    await updatePlayerData(playerId, updateExpression, attributeValues);
}

async function getPlayerData(playerId, projectionExpression)
{
    const params = {
        TableName: playerTableName,
        Key: {
            "id": playerId
        },
        ProjectionExpression: projectionExpression
    };
    try {
      return documentClient.get(params).promise();
    }
    catch (err) {
      console.log("Error getting player data: "+err);
      throw err;
    }
}

async function updatePlayerData(playerId, updateExpression, attributeValues)
{
    const params = {
        TableName: playerTableName,
        Key: {
            "id": playerId
        },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: attributeValues,
    };
    try {
      return documentClient.update(params).promise();
    }
    catch (err) {
      console.log("Error updating player data "+err);
      throw err;
    }
}

async function updateLatestChestOpenTimes(chestOpenTimes)
{
    for (let i = 7; i > 0; i--) //move all times down by one, drop the oldest time
        chestOpenTimes[i] = chestOpenTimes[i-1];
        
    chestOpenTimes[0] = getCurrentEpochTime();
    
    await updatePlayerData(playerId, "set latestChestOpenTimes = :lcot", {":lcot": chestOpenTimes});
}

async function updateNormalMissionData(playerId, missionId)
{
    const params = {
        TableName: playerTableName,
        Key: {
            "id": playerId
        },
        UpdateExpression: "set lastNormalMissionCleared = :lnmc",
        ExpressionAttributeValues:{":lnmc": missionId},
    };
    try {
      return documentClient.update(params).promise();
    }
    catch (err) {
      console.log("Error updating last cleared normal mission "+err);
      throw err;
    }
}

async function getGameData()
{
    const params = {
        TableName: generalTableName,
        Key: {
            "id": 0
        }
    };
    try {
      return documentClient.get(params).promise();
    }
    catch (err) {
      console.log("Error getting general table data: "+err);
      throw err;
    }
}

function getCurrentEpochTime()
{
    var d = new Date();
    return Math.floor( d / 1000 );
}

// Create a response
function sendResponse(statusCode, message) 
{
  return {
    statusCode: statusCode,
    headers: {
            "Access-Control-Allow-Headers" : "Content-Type",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "OPTIONS,POST,GET"
    },
    body: JSON.stringify(message)
  };
}

function getRandomNumber()
{
    return rand.random(); 
}

function initializeClearRewards()
{
    normalClearRewards[6] = 150;
    normalClearRewards[12] = 450;
    normalClearRewards[18] = 900;
    normalClearRewards[24] = 1500;
    normalClearRewards[30] = 3000;
    
    challengeClearRewards[3] = 100;
    challengeClearRewards[6] = 250;
    challengeClearRewards[9] = 450; //this might be harder than 12, 400 clears vs 800 at Jan 15, 2021
    challengeClearRewards[12] = 500; 
    challengeClearRewards[14] = 600;
    challengeClearRewards[16] = 800;
    challengeClearRewards[21] = 1000;
    challengeClearRewards[24] = 1500;
    challengeClearRewards[26] = 3000;
    challengeClearRewards[30] = 5000;
}