const AWS = require('aws-sdk');
AWS.config.update({ region: "us-west-1" });
const documentClient = new AWS.DynamoDB.DocumentClient({ region: "us-west-1" });

const jwt = require('jsonwebtoken');
const jwtSecretKey = "mock-secure-secret-key"; // Mock, replaced with the real secure secret key

const playerTableName = "WackyDungeonPlayers"; // DEV
const tokenTableName = "WackyDungeonAccessTokens"; // DEV
const generalTableName = "WackyDungeonGeneralTable";

// Blockchain-related mock values
const ethers = require('ethers');
const { createAlchemyWeb3 } = require("@alch/alchemy-web3");
const alchemyAPIKey = "_vDGebu4wFiZR3sKkb-_u5JbafUjnp1U"; // DEV
const alchemyAPIUrl = "https://eth-rinkeby.alchemyapi.io/v2/" + alchemyAPIKey; // DEV, Rinkeby

const NFTContractJSON = require("./ABI/Heroes-ABI.json");
const NFTContractAddress = "0xD318024a96e6c9A53c624D4d175c327F0D9ec405";

const traitContractJSON = require("./ABI/Traits-ABI.json");
const traitContractAddress = "0x212b5D25641439A84Aa086349b3047d7C124915B";

const web3 = createAlchemyWeb3(alchemyAPIUrl);

const accessTokenExpirationTime = 86400; // 24 hours in seconds

exports.handler = async (event) => {
    const body = JSON.parse(event.body);
    const walletAddress = body.walletAddress;
    const signature = body.signature;
    const nonce = body.nonce;
    const sentAccessToken = body.sentAccessToken;

    const message =
        "To login to Wacky Dungeon Deluxe and prove that you're the rightful owner of this wallet, please sign "
        + "this message. This won't cost you anything!\n\n"
        + "Your login ID: " + nonce + "\n(You don't need to memorize this)";

    if (sentAccessToken) {
        if (!walletAddress) return sendResponse(401, "ACCESS DENIED");

        try {
            let accessTokenData = await getTokenData(walletAddress);
            const storedToken = accessTokenData.Item?.accessToken?.value;

            try {
                const decodedToken = jwt.verify(sentAccessToken, jwtSecretKey);
                if (decodedToken.walletAddress !== walletAddress) {
                    console.log("Token walletAddress mismatch.");
                    return sendResponse(401, "ACCESS DENIED");
                }
                console.log("JWT verified successfully for walletAddress: " + walletAddress);
            } catch (err) {
                console.log("JWT verification failed: " + err.message);
                return sendResponse(401, "ACCESS DENIED");
            }

            if (!storedToken || storedToken !== sentAccessToken) {
                console.log("Stored token mismatch. Prompt user to retry.");
                return sendResponse(200, { op: 500, status: "RETRY", message: "RETRY LOGIN" });
            }
        } catch (e) {
            console.log("Error retrieving token data.");
            return sendResponse(200, { op: 500, status: "RETRY", message: "RETRY LOGIN" });
        }
    } else {        
      // Check if the nonce has expired
        try {
            let gameData = await getGameData("validNonces");
            let validNonces = gameData.Item?.validNonces || [];
            let nonceData = validNonces.find(nonceObj => nonceObj.id === nonce);
        
            if (nonceData) {
                if (nonceData.expirationTime < getCurrentEpochTime()) {
                    console.log(`Nonce ${nonce} has expired. Expired at ${nonceData.expirationTime}, current time is ${getCurrentEpochTime()}.`
                    );
                    return sendResponse(200, {
                        op: 500,
                        status: "EXPIRED",
                        message: "RETRY LOGIN",
                    });
                }
            } else {
                console.log(`Nonce ${nonce} is not present in the list and may have expired.`);
                return sendResponse(200, {
                    op: 500,
                    status: "EXPIRED",
                    message: "RETRY LOGIN",
                });
            }
        } catch (error) {
            console.error("Error checking nonce expiration: ", error);
            return sendResponse(200, {
                op: 500,
                status: "RETRY",
                message: "RETRY LOGIN",
            });
        }
        
        // Verify the signature
        if (!verifySignature(message, walletAddress, signature)) {
            console.log(`Access denied for wallet ${walletAddress}. Message: "${message}", Signature: "${signature}".`);
            return sendResponse(401, "ACCESS DENIED");
        }
    }

    // After access token and signature verification, proceed to checking all NFTs owned by the player
    const NFTContract = new web3.eth.Contract(NFTContractJSON, NFTContractAddress);

    try {
        // Check the number of NFTs owned by the player
        let NFTBalance = await NFTContract.methods.balanceOf(walletAddress).call();
    
        // If the player owns no NFTs, send an empty response
        if (NFTBalance == 0) {
            return sendResponse(200, { op: 500, status: "OK", NFTsOwned: {} });
        }
    
        const traitContract = new web3.eth.Contract(traitContractJSON, traitContractAddress);
        let walletNFTs = [];
        let nftIdList = [];
    
        // Iterate over the NFTs owned by the player
        for (let i = 0; i < NFTBalance; i++) {
            try {
                // Get the current NFT ID
                const currNFTId = await NFTContract.methods.tokenOfOwnerByIndex(walletAddress, i).call();
    
                // Retrieve player data associated with this NFT
                const playerRecord = await getPlayerData(currNFTId);
    
                // Retrieve metadata for the NFT
                const NFTMetadata = await traitContract.methods.metadata(currNFTId).call();
    
                // Extract and decode the metadata payload (JSON in base64 format)
                const metadataPayload = NFTMetadata.substring(NFTMetadata.indexOf(",") + 1); // Remove "data:application/json;base64,"
                const JSONMetadata = JSON.parse(Buffer.from(metadataPayload, 'base64').toString('ascii'));
        
                // Add NFT data to the walletNFTs array
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
    
                // Add NFT ID to the list
                nftIdList.push(currNFTId.toString());
            } catch (err) {
                console.log(`Error processing NFT at index ${i}: `, err);
            }
        }
    
        let accessToken;

        // If the client provided a valid access token, reuse it
        if (sentAccessToken && accessTokenData?.Item?.accessToken?.value === sentAccessToken) {
            console.log("Valid access token provided. Reusing existing token.");            
        } else {
            // Generate a new access token
            accessToken = jwt.sign(
                {
                    walletAddress: walletAddress,
                    nftIds: nftIdList,
                    exp: Math.floor(Date.now() / 1000) + accessTokenExpirationTime, // Token expiration time
                },
                jwtSecretKey
            );
        
            // Store the new access token in the database
            try {
                await updateTokenData(walletAddress, "set accessToken = :at", {
                    ":at": { value: accessToken },
                });
                console.log("Updated access token, value: " + accessToken);
            } catch (e) {
                console.log("Error updating access token in the database: ", e);
            }
        }
        
    
        // Return the access token and the player's NFTs
        return sendResponse(200, { op: 500, status: "OK", accessToken: accessToken, NFTsOwned: walletNFTs });
    } catch (err) {
        console.log("Unexpected error during NFT processing: ", err);
        return sendResponse(500, { op: 500, status: "ERROR", message: "An error occurred during login." });
    }
    
};

function verifySignature(message, address, signature) {
    try {
        const signerAddress = ethers.utils.verifyMessage(message, signature);
        return signerAddress === address;
    } catch (e) {
        console.log("Error in signature verification: ", e);
        return false;
    }
}

async function getGameData(projectionExpression) {
    const params = {
        TableName: generalTableName,
        Key: { id: 0 },
        ProjectionExpression: projectionExpression,
    };
    return documentClient.get(params).promise();
}

async function getPlayerData(playerId) {
    const params = {
        TableName: playerTableName,
        Key: { id: playerId },
    };
    return documentClient.get(params).promise();
}

async function getTokenData(walletAddress) {
    const params = {
        TableName: tokenTableName,
        Key: { walletAddress },
    };
    return documentClient.get(params).promise();
}

async function updateTokenData(walletAddress, updateExpression, attributeValues) {
    const params = {
        TableName: tokenTableName,
        Key: { walletAddress },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: attributeValues,
    };
    return documentClient.update(params).promise();
}

function sendResponse(statusCode, message) {
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
