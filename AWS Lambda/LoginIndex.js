const AWS = require('aws-sdk');
AWS.config.update({region: "us-west-1"});
const documentClient = new AWS.DynamoDB.DocumentClient({region: "us-west-1"});

const playerTableName = "WackyDungeonPlayers"; //DEV
const tokenTableName = "WackyDungeonAccessTokens"; //DEV
const generalTableName = "WackyDungeonGeneralTable";

//BLOCKCHAIN-RELATED MOCK VALUES
const ethers = require('ethers');
const { createAlchemyWeb3 } = require("@alch/alchemy-web3");
const alchemyAPIKey = "_vDGebu4wFiZR3sKkb-_u5JbafUjnp1U"; //DEV
const alchemyAPIUrl = "https://eth-rinkeby.alchemyapi.io/v2/" + alchemyAPIKey; //DEV, Rinkeby

const NFTContractJSON = require("./ABI/Heroes-ABI.json");
const NFTContractAddress = "0xD318024a96e6c9A53c624D4d175c327F0D9ec405";

const traitContractJSON = require("./ABI/Traits-ABI.json");
const traitContractAddress = "0x212b5D25641439A84Aa086349b3047d7C124915B";

const web3 = createAlchemyWeb3(alchemyAPIUrl);

const { v4: uuidv4 } = require('uuid');
const accessTokenExpirationTime = 86400; //24h in seconds

//The login function checks that we indeed own an NFT for the game, and asks the client to sign a message with his crypto wallet. 
//To improve security, the message will always include a nonce, which is only valid for a short period of time.

exports.handler = async (event) => 
{
    const body = JSON.parse(event.body);
    let walletAddress = body.walletAddress;
    const signature = body.signature; //check whether the signature we've been sent is a match
    const nonce = body.nonce;
    
    const message = 
    "To login to Wacky Dungeon Deluxe and prove that you're the rightful owner of this wallet, please sign "
    +"this message. This won't cost you anything!\n\n"
    +"Your login ID: "+nonce+"\n(You don't need to memorize this)"; 

    const sentAccessToken = body.sentAccessToken;
    
    if (sentAccessToken != undefined && sentAccessToken != "")
    {
      if (walletAddress == undefined) //Undefined wallet address cases should not happen with a proper client              
        return sendResponse(401, "ACCESS DENIED");
      
      //verify that this accessToken matches with the one in the db
      try {
        let accessTokenData = await getTokenData(walletAddress);

        //Check whether this token has expired, so I guess it should be 
        if (accessTokenData.Item.accessToken != undefined)
        {
          if (accessTokenData.Item.accessToken.expirationTime < getCurrentEpochTime()) //send new token if the old one has expired          
            return sendResponse(200, {op: 500, status: "RETRY", message: "RETRY LOGIN"});          
        }

        if (accessTokenData.Item.accessToken.value != sentAccessToken) //the client has not sent us a valid accessToken in the login
        {
          console.log("The sent accessToken " + sentAccessToken + " does not match the stored token "+ accessTokenData.Item.accessToken.value + ", ask the player to request a nonce and log in the long way");
          return sendResponse(200, {op: 500, status: "RETRY", message: "RETRY LOGIN"});
        }
        console.log("The sent access token " + sentAccessToken + " matches the stored token " + accessTokenData.Item.accessToken.value + ", skip signature verification");
        //otherwise we can proceed with normally
      }
      catch (e) {
        return sendResponse(200, {op: 500, status: "RETRY", message: "RETRY LOGIN"}); //Should not happen, but in case it does, prompt user to retry
      }
    }
    else
    {
      //check if the nonce has expired
      try {
        let gameData = await getGameData("validNonces");
        let nonceIndex = -1;

        for (let i = 0; i < gameData.Item.validNonces.length; i++)
        {
          if (gameData.Item.validNonces[i].id == nonce)
          {
            nonceIndex = i;
            break;
          }
        }

        if (nonceIndex >= 0)
        {
          if (gameData.Item.validNonces[nonceIndex].expirationTime < getCurrentEpochTime())
          {
            console.log("Nonce " + nonce + " has expired at " + gameData.Item.validNonces[nonceIndex].expirationTime + ", current time is " + getCurrentEpochTime());
            return sendResponse(200, {op: 500, status: "EXPIRED", message: "RETRY LOGIN"});
          }
        }
        else //nonce that has been sent is not in the list of valid nonces anymore, so it must've expired
        {
          console.log("Nonce " + nonce + " is not present in the list, so it must've expired");
          return sendResponse(200, {op: 500, status: "EXPIRED", message: "RETRY LOGIN"}); 
        }
        
      }
      catch (e) {
        console.log(e);
        return sendResponse(200, {op: 500, status: "RETRY", message: "RETRY LOGIN"}); 
      }
      
      if (!verifySignature(message, walletAddress, signature))
      {
        console.log("Deny access for " + walletAddress + ", message was " + message + ", and the signature was "+signature);
        return sendResponse(401, "ACCESS DENIED");
      }
    }
    //if no valid access token sent, continue the login process as usual

    const NFTContract = new web3.eth.Contract(NFTContractJSON, NFTContractAddress);    
    let NFTBalance = await NFTContract.methods.balanceOf(walletAddress).call(); //check the ids of the NFT the player owns

    if (NFTBalance == 0)
    return sendResponse(200, {op: 500, status: "OK", NFTsOwned: {}}); //empty response, we can't login since we don't own an NFT

    const traitContract = new web3.eth.Contract(traitContractJSON, traitContractAddress);
    let walletNFTs = new Array(parseInt(NFTBalance));
    let playerRecord, NFTMetadata, metadataPayload, JSONMetadata, currNFTId;
    
    for (let i = 0; i < NFTBalance; i++)
    {
        currNFTId = await NFTContract.methods.tokenOfOwnerByIndex(walletAddress, i).call();
        playerRecord = await getPlayerData(currNFTId);
        NFTMetadata = await traitContract.methods.metadata(currNFTId).call();
        metadataPayload = NFTMetadata.substring(NFTMetadata.indexOf(",")+1);//take off the "data:application/json;base64,"
        JSONMetadata = JSON.parse(Buffer.from(metadataPayload,'base64').toString('ascii'));

        if (playerRecord.Item == undefined) //Skip if no data found. Note: This should never happen in the PROD version, as all NFTs should have their stats in the db
        continue; 

        walletNFTs[i] =
        {
          id: currNFTId,
          currentXp: playerRecord.Item.saveData.xp,
          imageUrl: JSONMetadata.image,          
          bg: JSONMetadata.attributes[0].value,
          clothes: JSONMetadata.attributes[1].value,
          face: JSONMetadata.attributes[2].value,
          hair: JSONMetadata.attributes[3].value,
          shoes: JSONMetadata.attributes[4].value,
          weapons: JSONMetadata.attributes[5].value,
          attack: JSONMetadata.attributes[6].value,
          defense: JSONMetadata.attributes[7].value,
          hp: JSONMetadata.attributes[8].value,
          sp: JSONMetadata.attributes[9].value,
          xp: JSONMetadata.attributes[10].value,
          gold: JSONMetadata.attributes[11].value,
          kibble: JSONMetadata.attributes[12].value,
          spUsage: JSONMetadata.attributes[13].value,
          healing: JSONMetadata.attributes[14].value
        }
      }    
 
    const accessToken = uuidv4();
    let nftIdList = new Array(NFTBalance);
    
    for (let i = 0; i < NFTBalance; i++)
    nftIdList[i] = walletNFTs[i].id.toString();
    
    console.log("Give wallet " +walletAddress+ " an accessToken: "+accessToken);
    
    try {
      await updateTokenData(walletAddress, "set accessToken = :at, nftIds = :ni", 
      {":at": {value: accessToken, expirationTime: (getCurrentEpochTime() + accessTokenExpirationTime)}, ":ni": nftIdList});

      console.log("Updated access token, value: "+ accessToken + ", expirationTime: "+ (getCurrentEpochTime() + accessTokenExpirationTime));
    }
    catch (e){
      console.log(e);
    }
        
    return sendResponse(200, {op: 500, status: "OK", accessToken: accessToken, NFTsOwned: walletNFTs});
};

function verifySignature(message, address, signature)
{
    try {
        const signerAddress = ethers.utils.verifyMessage(message, signature);

        if (signerAddress === address)
        {
            console.log("Signature verified!");
            return true;
        }
        else
        {
            console.log("Signature doesn't match the address!");
            return false;
        }
    }
    catch (e) 
    {
        console.log(e);
    }
}

async function getGameData(projectionExpression)
{
    const params = {
        TableName: generalTableName,
        Key: {
            "id": 0
        },
        ProjectionExpression: projectionExpression
    };
    try {
      return documentClient.get(params).promise();
    }
    catch (err) {
      console.log("Error getting general table data: "+err);
      throw err;
    }
}

async function getPlayerData(playerId, projectionExpression)
{
    console.log("Getting data for player " + playerId);
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

async function getTokenData(walletAddress)
{
    console.log("Getting access token data for " + walletAddress);
    const params = {
        TableName: tokenTableName,
        Key: {
            "walletAddress": walletAddress
        }
    };
    try {
      return documentClient.get(params).promise();
    }
    catch (err) {
      console.log("Error getting access token data: "+err);
      throw err;
    }
}

async function updateTokenData(walletAddress, updateExpression, attributeValues)
{
    const params = {
        TableName: tokenTableName,
        Key: {
            "walletAddress": walletAddress
        },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues:attributeValues,
    };
    try {
      return documentClient.update(params).promise();
    }
    catch (err) {
      console.log("Error updating player data "+err);
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
