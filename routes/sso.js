var fs = require('fs');
const saml = require('samlify');
const express = require('express');
// const validator = require('@authenio/samlify-xsd-schema-validator');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const sql = require('../mysql');
const config = require('../config');
const router = express.Router();
const ServiceProvider = saml.ServiceProvider;
const IdentityProvider = saml.IdentityProvider;
var path = require('path');

// TODO: Add some sort of SAML validation
// saml.setSchemaValidator(validator);
saml.setSchemaValidator({
  validate: (response) => {
    /* implment your own or always returns a resolved promise to skip */
    return Promise.resolve('skipped');
  }
});

const defaultSettingsSP = {
  wantAssertionsSigned: true,
  entityID: `${config.app.protocol}://${config.app.host}`,
  nameIDFormat: ['urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'],
  assertionConsumerService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', Location: `${config.app.protocol}://${config.app.host}/acs` }],
  singleLogoutService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', Location: `${config.app.protocol}://${config.app.host}/logout` }]
};

let defaultServiceProvider = ServiceProvider(defaultSettingsSP);

router.get('/', (req, res) => {
  res.redirect(`https://${config.docsink.host}/sso/login`);
});

router.get('/metadata/:idp?', (req, res) => {
  let idpCode = req.params.idp || req.query.idp || '';

  let serviceProvider;
  if (!idpCode) {
    serviceProvider = defaultServiceProvider
  } else {
    serviceProvider = ServiceProvider({
      wantAssertionsSigned: true,
      entityID: `${config.app.protocol}://${config.app.host}/${idpCode}`,
      nameIDFormat: ['urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'],
      assertionConsumerService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', Location: `${config.app.protocol}://${config.app.host}/acs/${idpCode}` }],
      singleLogoutService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', Location: `${config.app.protocol}://${config.app.host}/logout/${idpCode}` }]
    });
  }
  res.header('Content-Type', 'text/xml').send(serviceProvider.getMetadata())
});

router.get('/login', async (req, res) => {
  console.log('/login');
  let email = req.query.email;
  console.log(email);
  if (!email) {
    console.log(req.hostname);
    res.redirect(req.hostname);
  }

  let selectQuery = `
    select
      u.email,
      u.org_id,
      si.email_domain,
      si.metadata_url,
      si.idp_code
    from user u
    join org_idp_lookup oil
      on oil.org_id = u.org_id
    join sso_idp si
      on si.id = oil.sso_idp_id
    where email = ?
  `

  await sql.query(selectQuery, [email], async (err, results, fields) => {
    if (err) throw err;
    console.log(results);
    if (!results.length) {
      res.redirect(req.host);
    }

    let url = results[0].metadata_url;

    if (url) {
      await request(url, async function (error, response, body) {
        console.error('error:', error); // Print the error if one occurred

        let idp = await IdentityProvider({ metadata: body });
        const { id, context } = await defaultServiceProvider.createLoginRequest(idp, 'redirect');
        return await res.redirect(context);
      });
    }
  });
});

router.get('/login/:idp?', async (req, res) => {
  console.log('SP initiated login request received');

  try {
    let idpCode = req.params.idp || req.query.idp || req.body.RelayState;
    let sid = req.query.sid;

    console.log(`IdP code: ${idpCode}`);
    console.log(`Sid: ${sid}`);

    if (!idpCode) {
      console.log('missing IdP code in request');
      // res.status(400).send('IdP code missing in request. Must be set as path paramater, query parameter, or as relay state.');
      res.status(400).render('pages/index', { reason: 'IdP code missing in request. Must be set as path paramater, query parameter, or as relay state.' });
      return;
    }

    let idpInfo = await getIdP(idpCode);
    let idpUrl = idpInfo.metadata_url;
    let idpXml = idpInfo.metadata_xml;

    if (!idpUrl && !idpXml) {
      console.log('IdP metadata not set');
      //res.status(500).send('IdP metadata not set');
      res.status(500).render('pages/index', { reason: 'IdP metadata not set' })
      return;
    }

    if (!idpXml) {
      console.log('fetching IdP metadata from url');
      idpXml = await axios.get(idpUrl);
    }

    let idp = IdentityProvider({ metadata: idpXml });
    let spConfig = Object.assign({}, defaultSettingsSP);
    spConfig.assertionConsumerService = [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', Location: `${config.app.protocol}://${config.app.host}/acs/${idpCode}` }]
    let sp = ServiceProvider(spConfig);

    const { id, context: contextURL } = sp.createLoginRequest(idp, 'redirect');

    let parsedURL = new URL(contextURL);
    if (sid) {
      parsedURL.searchParams.append('RelayState', `{"sid": "${sid}"}`);
      return res.redirect(parsedURL.toString());
    }

    // res.cookie('di.sid', sid);
    return res.redirect(context);
  } catch (err) {
    console.log('redirecting to error page.')
    console.error(err);
    res.status(500).render('pages/index', err);
    // res.status(500).sendFile(path.join(__dirname, '../public/index.html'));
    return;
  }
});

router.all('/acs/:idp?', async (req, res) => {
  console.log('IdP initiatiated login request received', req);

  try {
    let idpCode = req.params.idp || req.query.idp;
    console.log('req.body=======>', req)

    console.log(`idPCode: ${idpCode}`);    
    console.log(`RelayState: ${req.body.RelayState}`);
    
    // console.log('redirect to https://dev-extension.docsink.com');

    // if (idpCode == 'athena') {
    //   res.redirect(301, 'https://dev-caremanager.docsink.com');
    //   return;
    // }

    let sid;
    if (req.body.RelayState[0] == '{') {
      let relayState = JSON.parse(req.body.RelayState);
      sid = relayState.sid;
    }

    if (!idpCode) {
      console.log('missing IdP code in request');
      //res.status(400).send('IdP code missing in request. Must be set as path paramater, query parameter, or as relay state.');
      res.status(400).render('pages/index', { reason: 'IdP code missing in request. Must be set as path paramater, query parameter, or as relay state.' });
    }

    let idpInfo = await getIdP(idpCode);
    let idpUrl = idpInfo.metadata_url;
    let idpXml = idpInfo.metadata_xml;

    if (!idpUrl && !idpXml) {
      console.log('IdP metadata not set');
      //res.status(500).send('IdP metadata not set');
      res.status(500).render('pages/index', { reason: 'IdP metadata not set' });
    }

    if (!idpXml) {
      console.log('fetching IdP metadata from url');
      idpXml = await axios.get(idpUrl);
    }


    let idp = IdentityProvider({ metadata: idpXml });

    console.log('parsing SAML assertion');
    let parseResult = await defaultServiceProvider.parseLoginResponse(idp, 'post', req);

    let email;
    let orgID;
    let patientUUID;
    let locationUUID;
    let tokenData;

    if (idpCode == 'athena') {
      let handlerResponse = await athenaSAMLHandler(parseResult);
      console.log('handlerResponse==>', JSON.stringify(handlerResponse))
      if (handlerResponse.status == 'error') {
        // res.status(500).send('<pre>' + JSON.stringify(handlerResponse, null, 2) + '</pre>');
        res.status(500).render('pages/index', { reason: handlerResponse });
        return;
      }

      ({ email, orgID, patientUUID, locationUUID } = handlerResponse);

      tokenData = {
        org_id: orgID,
        email: email,
        patient_uuid: patientUUID,
        location_uuid: locationUUID
      }
      console.log('tokenData==>', tokenData)
    } else if (idpCode == 'steward') {
      tokenData = await stewardSAMLHandler(parseResult);
    } else {
      email = parseResult.extract.nameID;
      orgID = await getUserOrgID(email);
    }
    console.log('Token Data', tokenData)
    if (!tokenData.email) {
      // res.status(400).send('<pre>' + JSON.stringify({ status: 'error', reason: 'email missing in SAML assertion' }, null, 2) + '</pre>');
      res.status(400).render('pages/index', { status: 'error', reason: 'email missing in SAML assertion' })
      return;
    }
    if (tokenData.email == 'support@docsink.com') {
      res.redirect(301, config.docsink.care_manager_url);
      return;
    }
    if (!tokenData.org_id && !tokenData.allowedOrgs) {
      //res.status(400).send('<pre>' + JSON.stringify({ status: 'error', reason: 'user email not linked to an active organization' }, null, 2) + '</pre>');
      res.status(400).render('pages/index', { status: 'error', reason: 'user email not linked to an active organization.' })
      return;
    }

    let jwtToken = jwt.sign({
      data: tokenData
      // data: {
      //   org_id: orgID,
      //   email: email,
      //   patient_uuid: patientUUID,
      //   location_uuid: locationUUID
      // }
    }, config.app.key, { expiresIn: 60 * 1 });

    var redirectURL = `https://${config.docsink.host}/sso`;

    if (tokenData.email == 'support@docsink.com') {
      redirectURL = config.docsink.care_manager_url;
    } if (!tokenData.org_id) {
      redirectURL += '/registration';
    } else if (sid) {
      redirectURL += '/extension';
    } else if (config.athena.embedded_app_orgs.includes(tokenData.org_id)) {
      redirectURL = config.docsink.care_manager_url;
    } else {
      redirectURL += '/authenticated';
    }

    redirectURL += `?token=${jwtToken}`;

    if (sid) {
      redirectURL += `&sid=${sid}`;
    }

    console.log(`redirecting user to ${redirectURL}`);

    await axios.get(redirectURL)
      .then(data => {
        res.redirect(301, redirectURL);
      })
      .catch(ex => {
        let reason = null;
        if (typeof ex.response.data == 'object' && ex.response.data) {
          reason = ex.response.data.error
          res.status(ex.response.status).render('pages/index', { reason: reason });
        }
      })

    res.redirect(301, redirectURL);

  } catch (err) {
    console.error(err);
    return res.render('pages/index', err);
  }
});

async function athenaSAMLHandler(parseResult) {
  console.log('athena saml handler', parseResult);

  let email = parseResult.extract.attributes.email;
  let patientID = parseResult.extract.attributes.patientid;
  let practiceID = parseResult.extract.attributes.practiceid;
  let username = parseResult.extract.attributes.subject;
  let departmentID = parseResult.extract.attributes.departmentid;

  console.log(JSON.stringify({
    email: email,
    patient_id: patientID,
    practice_id: practiceID,
    username: username,
    department_id: departmentID
  }));
  
  if (email == 'support@docsink.com') {
    return {
      email
    };
  }

  let orgID = await getUserOrgID(email);

  if (orgID == 0) {
    //return { status: "error", reason: `User not found in DocsInk for ${email}` };
    return res.status(400).render('pages/index', { status: "error", reason: `User not found in DocsInk for ${email}` })
  }

  console.log('retrieving patient UUID from athena bot');
  let integrationResponse;

  try {
    integrationResponse = await axios.get(
      `${config.integration.protocol}://${config.integration.host}/integration/athena/sso?org_id=${orgID}&patient_id=${patientID}&practice_id=${practiceID}&email=${encodeURIComponent(email)}&username=${username}&department_id=${departmentID}`
    );
  } catch (ex) {
    console.error(ex);
    throw { status: "error", reason: `Internal server error processing SSO request`, data: { practiceID, departmentID, username, email, patientID } };
  }
  console.log('integrationResponse', integrationResponse);
  return {
    email: integrationResponse.data.email,
    orgID: integrationResponse.data.orgID,
    patientUUID: integrationResponse.data.patient_uuid,
    locationUUID: integrationResponse.data.location_uuid
  }
}

async function stewardSAMLHandler(parseResult) {
  console.log('parseResult in stewardSAMLHandler ====>', parseResult)
  let email = parseResult.extract.nameID;
  let firstName = parseResult.extract.attributes['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'];
  let lastName = parseResult.extract.attributes['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'];
  let orgID = await getUserOrgID(email);

  let data = {
    email,
    org_id: orgID,
    first_name: firstName,
    last_name: lastName
  }

  if (!orgID) {
    data.allowedOrgs = config.docsink.steward.orgs
  }

  return data;
}

function getIdP(idpCode) {
  console.log('Querying IdP from database');
  return new Promise((resolve, reject) => {
    sql.query('SELECT * FROM sso_idp WHERE idp_code = ?', [idpCode], (err, results, fields) => {
      if (err) reject(err);

      if (results.length == 0) {
        reject('IdP not found');
        return;
      }

      resolve(results[0]);
    });
  });
};

function getUserOrgID(email) {
  console.log('Querying user organization from database');
  return new Promise((resolve, reject) => {
    sql.query('SELECT org_id FROM user WHERE email = ?', [email], (err, results, fields) => {
      if (err) reject(err);

      if (results.length == 0) {
        resolve(0);
        return;
      }

      resolve(results[0].org_id);
    })
  });
}

async function getUserBotOrgToken(email, appID) {
  console.log('Querying user organization and bot token from database');

  return new Promise((resolve, reject) => {
    sql.query(`
        SELECT u.org_id, bt.token
        FROM user u
        LEFT JOIN bot_tokens bt
          ON bt.org_id = u.org_id
            AND bt.app_id = ?
        WHERE u.email = ?;
      `, [appID, email], (err, results, fields) => {
      if (err) reject(err);

      if (results.length == 0) {
        reject('User not found');
        return;
      }

      resolve(results[0]);
    });
  });
}

module.exports = router;
