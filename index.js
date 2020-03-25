// Load environment variables from `.env` file (optional)
require('dotenv').config();

const { createEventAdapter } = require('@slack/events-api');
const { WebClient } = require('@slack/web-api');
const passport = require('passport');
const LocalStorage = require('node-localstorage').LocalStorage;
const SlackStrategy = require('@aoberoi/passport-slack').default.Strategy;
const http = require('http');
const express = require('express');

// *** Initialize event adapter using signing secret from environment variables ***
const slackEvents = createEventAdapter(process.env.SLACK_SIGNING_SECRET, {
  includeBody: true
});

const botAuthorizationStorage = new LocalStorage('./workspaces.db');
const stalkerStorage = new LocalStorage('./stalker.db');

function stalkIfAllowed(teamId, channel, message) {
  teamJSON = stalkerStorage.getItem(teamId);
  if (teamJSON) {
    obj = JSON.parse(teamJSON)
    if (obj[channel][message.user].length == 0) {
      return;
    }
    const slack = getClientByTeamId(teamId);
    obj[channel][message.user].forEach(emoji => {
      (async () => {
        try {
          const response = await slack.reactions.add({ channel: channel, name: emoji, timestamp: message.ts });
        } catch (error) {
          console.log(error.data);
        }
      })();
    });
  } 
}

function addStalk(teamId, channel, person, emojis) {
  teamJSONStr = stalkerStorage.getItem(teamId);
  var obj;
  if (teamJSONStr) {
    obj = JSON.parse(teamJSONStr);
    if (obj[channel][person].length == 0) {
      obj[channel][person] = emojis;
    } else {
      obj[channel][person].push(emojis);
    }
  } else {
    obj[channel][person] = emojis;
  }
  teamJSONStr = JSON.stringify(obj);
  stalkerStorage.setItem(teamId, teamJSONStr);
}

function removeStalk(teamId, channel, person) {
  teamJSONStr = stalkerStorage.getItem(teamId);
  var obj;
  if (teamJSONStr) {
    obj = JSON.parse(teamJSONStr);
    obj[channel][person] = [];
    teamJSONStr = JSON.stringify(obj);
    stalkerStorage.setItem(teamId, teamJSONStr);
  }
}

function parseUserId(text) {
  return text
			.replace(/<(.+?)(\|(.*?))?>/s, function(match) {
        return match.replace("<@", "").replace(">", "");
			});
}

const clients = {};
function getClientByTeamId(teamId) {
  if (!clients[teamId] && botAuthorizationStorage.getItem(teamId)) {
    clients[teamId] = new WebClient(botAuthorizationStorage.getItem(teamId));
  }
  if (clients[teamId]) {
    return clients[teamId];
  }
  return null;
}

// Initialize Add to Slack (OAuth) helpers
passport.use(new SlackStrategy({
  clientID: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  skipUserProfile: true,
}, (accessToken, scopes, team, extra, profiles, done) => {
  console.error(accessToken);
  console.error(team);
  console.error(extra);
  console.error(profiles);
  botAuthorizationStorage.setItem(team.id, extra.bot.accessToken);
  done(null, {});
}));

// Initialize an Express application
const app = express();

// Plug the Add to Slack (OAuth) helpers into the express app
app.use(passport.initialize());
app.get('/', (req, res) => {
  res.send('<a href="https://slack.com/oauth/v2/authorize?client_id=8302296951.1025855769415&scope=channels:history,commands,groups:history,im:history,reactions:write"><img alt="Add to Slack" height="40" width="139" src="https://platform.slack-edge.com/img/add_to_slack.png" srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x"></a>');
});
app.get('/slack/auth', passport.authenticate('slack', {
  scope: ['channels:history', 'commands', 'groups:history', 'im:history', 'reactions:write'] //['bot']
}));
app.get('/slack/auth/callback',
  passport.authenticate('slack', { session: false }),
  (req, res) => {
    res.send('<p>Greet and React was successfully installed on your team.</p>');
  },
  (err, req, res, next) => {
    console.error(req);
    res.status(500).send(`<p>Greet and React failed to install</p> <pre>${err}</pre>`);
  }
);

function stripEmojiEscape(emoji) {
  return emoji.replace(/:/g, "");
}

app.post('/slack/commands', (req, res) => {
  console.error(req);
  teamId = req.params['team_id'];
  channelId = req.params['channel_id'];
  text = req.params['text'];
  if (!teamId || !channelId || !text || !req.params['command']) {
    res.status(500).send("Something went wrong!");
    return;
  }
  args = text.split(" ");
  if (args.length <= 1) {
    res.send("Arguments should be @user <emojis>");
    return;
  }
  user = parseUserId(args[0]);
  switch(req.params['command']) {
    case '/stalk':
      emojis = args.slice(1).map(stripEmojiEscape);
      addStalk(teamId, channelId, user, emojis);
      res.send('{"text": "Got it! I will start stalking on next messages."');
      break;
    case '/unfollow':
      removeStalk(teamId, channelId, user);
      res.send('{"text": "Got it! I just unfollowed that person."');
      break;
    default:
      console.error('unsupported command ' + req.params['command']);
      res.send("OK")
  }
})

// *** Plug the event adapter into the express app as middleware ***
app.use('/slack/events', slackEvents.expressMiddleware());

// *** Attach listeners to the event adapter ***

slackEvents.on('message', (message, body) => {
  console.error(message);
  const slack = getClientByTeamId(body.team_id);
  if (!slack) {
    return console.error('No authorization found for this team. Did you install the app through the url provided by ngrok?');
  }
  stalkIfAllowed(body.team_id, message.channel_id, message);
});

// *** Handle errors ***
slackEvents.on('error', (error) => {
  if (error.code === slackEventsApi.errorCodes.TOKEN_VERIFICATION_FAILURE) {
    // This error type also has a `body` propery containing the request body which failed verification.
    console.error(`An unverified request was sent to the Slack events Request URL. Request body: \
${JSON.stringify(error.body)}`);
  } else {
    console.error(`An error occurred while handling a Slack event: ${error.message}`);
  }
});

// Start the express application
const port = process.env.PORT || 3000;
http.createServer(app).listen(port, () => {
  console.log(`server listening on port ${port}`);
});
