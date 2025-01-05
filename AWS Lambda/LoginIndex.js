const AWS = require('aws-sdk');
AWS.config.update({ region: "us-west-1" });
const documentClient = new AWS.DynamoDB.DocumentClient({ region: "us-west-1" });

const jwt = require('jsonwebtoken');
const ethers = require('ethers');
const { createAlchemyWeb3 } = require('@alch/alchemy-web3');

const STAGE = process.env.STAGE || "dev";

const JWT_SECRET_KEY = process.env[`JWT_SECRET_KEY_${STAGE.toUpperCase()}`];

const ALCHEMY_API_BASE_URL = process.env[`ALCHEMY_API_BASE_URL_${STAGE.toUpperCase()}`];
const ALCHEMY_API_KEY = process.env[`ALCHEMY_API_KEY_${STAGE.toUpperCase()}`];
const ALCHEMY_API_URL = `${ALCHEMY_API_BASE_URL}/${ALCHEMY_API_KEY}`;

const PLAYER_TABLE_NAME = process.env[`PLAYER_TABLE_NAME_${STAGE.toUpperCase()}`];
const TOKEN_TABLE_NAME = process.env[`TOKEN_TABLE_NAME_${STAGE.toUpperCase()}`];
const GENERAL_TABLE_NAME = process.env[`GENERAL_TABLE_NAME_${STAGE.toUpperCase()}`];

const NFT_CONTRACT_ADDRESS = process.env[`NFT_CONTRACT_ADDRESS_${STAGE.toUpperCase()}`];
const TRAIT_CONTRACT_ADDRESS = process.env[`TRAIT_CONTRACT_ADDRESS_${STAGE.toUpperCase()}`];
const ALCHEMY_API_URL = process.env[`ALCHEMY_API_URL_${STAGE.toUpperCase()}`];

const web3 = createAlchemyWeb3(ALCHEMY_API_URL);

const NFT_CONTRACT_JSON = require("./ABI/Heroes-ABI.json");
const TRAIT_CONTRACT_JSON = require("./ABI/Traits-ABI.json");

const ACCESS_TOKEN_EXPIRATION_TIME = 86400; // 24h in seconds

exports.handler = async (event) => 
{
    const body = JSON.parse(event.body);
    const walletAddress = body.walletAddress;
    const signature = body.signature;
    const nonce = body.nonce;
    const sentAccessToken = body.sentAccessToken;

    const message =
        "To login to Wacky Dungeon Deluxe and prove that you're the rightful owner of this wallet, please sign "
        + "this message. This won't cost you anything!\n\n"
        + "Your login ID: " + nonce + "\n(You don't need to memorize this)";

    // Validate JWT if an access token is sent
    if (sentAccessToken && !walletAddress)
        return sendResponse(401, "ACCESS DENIED");
        
    try 
    {
        let accessTokenData = await getTokenData(walletAddress);
        const storedToken = accessTokenData.Item?.accessToken?.value;

        try 
        {
            const decodedToken = jwt.verify(sentAccessToken, JWT_SECRET_KEY);
            if (decodedToken.walletAddress !== walletAddress) 
            {
                console.log("Token walletAddress mismatch.");
                return sendResponse(401, "ACCESS DENIED");
            }
            console.log("JWT verified successfully for walletAddress: " + walletAddress);
        } 
        catch (error) 
        {
            console.log("JWT verification failed: " + error.message);
            return sendResponse(401, "ACCESS DENIED");
        }

        if (!storedToken || storedToken !== sentAccessToken)
            return sendResponse(200, { op: 500, status: "RETRY", message: "RETRY LOGIN" });
    } 
    catch (error) 
    {
        return sendResponse(200, { op: 500, status: "RETRY", message: "RETRY LOGIN" });
    }

    // Validate the nonce to ensure it's still valid
    try 
    {
        let gameData = await getGameData("validNonces");
        let validNonces = gameData.Item?.validNonces || [];
        let nonceData = validNonces.find(nonceObj => nonceObj.id === nonce);

        if (!nonceData || nonceData.expirationTime < getCurrentEpochTime())
            return sendResponse(200, { op: 500, status: "EXPIRED", message: "RETRY LOGIN" });
    } 
    catch (error) 
    {
        return sendResponse(200, { op: 500, status: "RETRY", message: "RETRY LOGIN" });
    }

    // Verify the user's wallet signature for authentication
    if (!verifySignature(message, walletAddress, signature))
        return sendResponse(401, "ACCESS DENIED");

    const NFTContract = new web3.eth.Contract(NFT_CONTRACT_JSON, NFT_CONTRACT_ADDRESS);

    try 
    {
        // Fetch the NFT balance of the user's wallet
        let NFTBalance = await NFTContract.methods.balanceOf(walletAddress).call();

        if (NFTBalance == 0)
            return sendResponse(200, { op: 500, status: "OK", NFTsOwned: {} });

        const traitContract = new web3.eth.Contract(TRAIT_CONTRACT_JSON, TRAIT_CONTRACT_ADDRESS);
        let walletNFTs = [];
        let nftIdList = [];

        for (let i = 0; i < NFTBalance; i++) 
        {
            try 
            {
                const currNFTId = await NFTContract.methods.tokenOfOwnerByIndex(walletAddress, i).call();
                const playerRecord = await getPlayerData(currNFTId);
                const NFTMetadata = await traitContract.methods.metadata(currNFTId).call();

                const metadataPayload = NFTMetadata.substring(NFTMetadata.indexOf(",") + 1); 
                const JSONMetadata = JSON.parse(Buffer.from(metadataPayload, 'base64').toString('ascii'));

                walletNFTs.push({
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
                    healing: JSONMetadata.attributes[14].value,
                });

                nftIdList.push(currNFTId.toString());
            } 
            catch (error) 
            {
                console.log(`Error processing NFT at index ${i}: `, error);
            }
        }

        let accessToken;

        // Reuse or generate a new JWT access token
        if (sentAccessToken && accessTokenData?.Item?.accessToken?.value === sentAccessToken)
            console.log("Valid access token provided. Reusing existing token.");
        else 
        {
            accessToken = jwt.sign(
                {
                    walletAddress: walletAddress,
                    nftIds: nftIdList,
                    exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_EXPIRATION_TIME,
                },
                JWT_SECRET_KEY
            );

            try 
            {
                await updateTokenData(walletAddress, "set accessToken = :at", {
                    ":at": { value: accessToken },
                });
            } 
            catch (error) 
            {
                console.log("Error updating access token in the database: ", error);
            }
        }

        return sendResponse(200, { op: 500, status: "OK", accessToken: accessToken, NFTsOwned: walletNFTs });
    } 
    catch (error) 
    {
        return sendResponse(500, { op: 500, status: "ERROR", message: "An error occurred during login." });
    }
};

async function getGameData(projectionExpression)
{
    const params = {
        TableName: GENERAL_TABLE_NAME,
        Key: { id: 0 },
        ProjectionExpression: projectionExpression,
    };
    return documentClient.get(params).promise();
}

async function getPlayerData(playerId)
{
    const params = {
        TableName: PLAYER_TABLE_NAME,
        Key: { id: playerId },
    };
    return documentClient.get(params).promise();
}

async function getTokenData(walletAddress)
{
    const params = {
        TableName: TOKEN_TABLE_NAME,
        Key: { walletAddress },
    };
    return documentClient.get(params).promise();
}

async function updateTokenData(walletAddress, updateExpression, attributeValues)
{
    const params = {
        TableName: TOKEN_TABLE_NAME,
        Key: { walletAddress },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: attributeValues,
    };
    return documentClient.update(params).promise();
}

function sendResponse(statusCode, message)
{
    return {
        statusCode,
        headers: {
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
        },
        body: JSON.stringify(message),
    };
}
