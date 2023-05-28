var fs = require('fs');
const express = require('express');
const config = require('../config');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');

let stateMap = {};

router.get('/authorize', function (req, res, next) {
    try {
        const { query } = req;
        const { bot_name, referrer } = query;
        const token = extractToken(req);

        if (!bot_name || !referrer) {
            res.status(400).send('Missing required parameters');
            return;
        }

        let state = crypto.randomUUID();
        stateMap[state] = {
            bot_name,
            referrer,
            token
        };

        let params = {
            client_id: config[bot_name].client_id,
            redirect_uri: encodeURIComponent(config[bot_name].redirect_uri),
            response_type: 'code',
            scope: config[bot_name].scope,
            state: state
        };

        let url = `${config[bot_name].authorize_url}?${Object.keys(params).map(key => `${key}=${params[key]}`).join('&')}`;
        console.log("🚀 ~ file: oauth2.js:38 ~ url:", url)

        res.redirect(url);

    } catch (err) {
        console.log("🚀 ~ file: oauth2.js:41 ~ err in authorize=>>>>>>:", err);
        //res.status(500).send('Internal Server Error');
        res.status(500).send(err);
        return;
    }
});

router.get('/callback', async function (req, res, next) {
    try {

        const { query } = req;
        const { code, state } = query;

        if (!code || !state) {
            res.status(400).send('Missing required parameters');
            return;
        }
        let { bot_name, referrer, token } = stateMap[state];
        stateMap[state] = undefined;

        if (!bot_name) {
            res.status(400).send('Invalid state');
            return;
        }

        const formData = new URLSearchParams();
        formData.append('grant_type', 'authorization_code');
        formData.append('code', code);
        formData.append('redirect_uri', config[bot_name].redirect_uri);
        formData.append('client_id', config[bot_name].client_id);
        formData.append('client_secret', config[bot_name].client_secret);

        const resp = await axios.request({
            url: config[bot_name].token_url,
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data: formData
        });
        console.log("🚀 ~ file: oauth2.js:78 ~ POST /token api resp:", resp);

        const data = resp.data;

        const DexcomBotData = {"access_token":data.access_token , "refresh_token" : data.refresh_token , "expires_in" : data.expires_in};
        console.log("🚀 ~ file: oauth2.js:85 ~ url:", `${config.integration.bots_url}/api/dexcom/verify`);

        const dexcomBotResponse = await axios.request({
            url: `${config.integration.bots_url}/api/dexcom/verify`,
            method: 'POST',
            data : DexcomBotData,
            headers : {
                Authorization: `Bearer ${token}`,
            }
        }); 
        res.redirect(referrer);

    } catch (err) {
        console.log("🚀 ~ file: oauth2.js:95 ~ err in callback=>>>>>:", err)
        //res.status(500).send('Internal Server Error');
        res.status(500).send(err);
        return;
    }
});

function extractToken(req) {
    if (req.headers.authorization && req.headers.authorization.split(' ')[0] === 'Bearer') {
        return req.headers.authorization.split(' ')[1];
    } else if (req.query && req.query.token) {
        return req.query.token;
    }
    return null;
};

module.exports = router;
