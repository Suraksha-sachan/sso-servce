var createError = require('http-errors');
var express = require('express');
const config = require('./config');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
// const serverlessExpressMiddleware = require('@vendia/serverless-express/middleware')
const winston = require('winston');
const WinstonCloudWatch = require('winston-cloudwatch');

winston.add(new WinstonCloudWatch({
  level: config.app.logLevel,
  logGroupName: config.aws.logGroupName,
  logStreamName: config.aws.logStreamName,
  awsRegion: config.aws.region
}));

var oauthRouter = require('./routes/oauth2');
var ssoRouter = require('./routes/sso');

var app = express();
// app.use(serverlessExpressMiddleware.eventContext())

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use('/', ssoRouter);
app.use('/oauth2/', oauthRouter);
app.use(express.static(__dirname + '/public'));

// set the view engine to ejs
app.set('view engine', 'ejs');

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
});

module.exports = app;
