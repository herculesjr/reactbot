// Load environment variables from `.env` file (optional)
require('dotenv').config();

const { createEventAdapter } = require('@slack/events-api');
const { WebClient } = require('@slack/web-api');
const passport = require('passport');
const LocalStorage = require('node-localstorage').LocalStorage;
const SlackStrategy = require('@aoberoi/passport-slack').default.Strategy;
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');

// *** Initialize event adapter using signing secret from environment variables ***
const slackEvents = createEventAdapter(process.env.SLACK_SIGNING_SECRET, {
  includeBody: true
});

const botAuthorizationStorage = new LocalStorage('./workspaces.db');
const stalkerStorage = new LocalStorage('./stalker.db');

function stalkIfAllowed(slack, message) {
  teamJSON = stalkerStorage.getItem(message.team);
  if (teamJSON) {
    obj = JSON.parse(teamJSON)
    if (!obj || !obj[message.channel] || obj[message.channel].length == 0) {
      return;
    }
    toStalk = obj[message.channel].filter((item) => {
      return item[message.user] != null;
    })   
    toStalk.forEach(emojis => {
      console.error("emojis -> "+emojis);
      emojis.forEach(emoji => {
        (async () => {
          try {
            obj = { channel: message.channel, name: emoji, timestamp: message.ts };
            console.error(obj);
            const response = await slack.reactions.add(obj);
          } catch (error) {
            console.log(error.data);
          }
        })();
      })
    });
  } 
}

function addStalk(teamId, channel, person, emojis) {
  teamJSONStr = stalkerStorage.getItem(teamId);
  var obj;
  entry = {};
  entry[person] = emojis;
  if (teamJSONStr) {
    obj = JSON.parse(teamJSONStr);
    channelObj = obj[channel];  
    if (channelObj) {
      channelObj.push(entry);
    } else {
      channelObj = [entry];
    }
    obj[channel] = channelObj;
  } else {
    obj = {};
    obj[channel] = [entry];
  }
  teamJSONStr = JSON.stringify(obj);
  stalkerStorage.setItem(teamId, teamJSONStr);
}

function removeStalk(teamId, channel, person) {
  teamJSONStr = stalkerStorage.getItem(teamId);
  var obj;
  if (teamJSONStr) {
    obj = JSON.parse(teamJSONStr);
    channelObj = obj[channel];
    if (!channelObj) {
      return;
    }
    obj[channel] = obj[channel].filter((item) => {
      item[person] == null;
    });
    teamJSONStr = JSON.stringify(obj);
    stalkerStorage.setItem(teamId, teamJSONStr);
  }
}

function parseUserId(text) {
  return text
			.replace(/<(.+?)(\|(.*?))?>/s, function(match) {
        return match.replace("<@", "").replace(">", "").split("|")[0];
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
    res.status(500).send(`<p>Greet and React failed to install</p> <pre>${err}</pre>`);
  }
);

function stripEmojiEscape(emoji) {
  return emoji.replace(/:/g, "");
}
app.use('/slack/commands', bodyParser.urlencoded({ extended: true }));
app.post('/slack/commands', (req, res) => {
  teamId = req.body['team_id'];
  channelId = req.body['channel_id'];
  text = req.body['text'];
  if (!teamId || !channelId || !text || !req.body['command']) {
    res.status(500).send("Something went wrong!");
    return;
  }
  args = text.trim().split(" ");
  user = parseUserId(args[0]);
  switch(req.body['command']) {
    case '/stalk':
      if (args.length <= 1) {
        res.send("Arguments should be @user <emojis>");
        return;
      }
      emojis = args.slice(1).join("").split(":").filter((item) => { return item.trim().length != 0 });
      addStalk(teamId, channelId, user, emojis);
      res.send('Got it! I will start stalking on next messages.');
      break;
    case '/unfollow':
      if (args.length > 1) {
        res.send("Argument should be @user");
        return;
      }
      removeStalk(teamId, channelId, user);
      res.send('Got it! I just unfollowed that person.');
      break;
    default:
      console.error('unsupported command ' + req.body['command']);
      res.send("OK")
  }
})

// *** Plug the event adapter into the express app as middleware ***
app.use('/slack/events', slackEvents.expressMiddleware());

// *** Attach listeners to the event adapter ***

slackEvents.on('message', (message, body) => {
  const slack = getClientByTeamId(body.team_id);
  if (!slack) {
    return console.error('No authorization found for this team.');
  }
  stalkIfAllowed(slack, message);
});

// *** Handle errors ***
slackEvents.on('error', (error) => {
    console.error(error);
});

// Start the express application
const port = process.env.PORT || 3000;
http.createServer(app).listen(port, () => {
  console.log(`server listening on port ${port}`);
});
