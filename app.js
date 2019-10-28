/* Express template stuff */
var createError = require('http-errors');
var express = require('express');
var path = require('path');
var logger = require('morgan');

/* Database */
const assert = require('assert');
const mongodb = require('mongodb');

/* Routers */
var manRouter = require('./routes/man');
var apiRouter = require('./routes/api');
var reposRouter = require('./routes/repos');

/* Connect to DB */
mongodb.MongoClient.connect('mongodb://localhost:27017', function(error, client) {
	assert.ifError(error);
	const db = client.db('cranlike');
	global.bucket = new mongodb.GridFSBucket(db, {bucketName: 'files'});
	global.packages = db.collection('packages');
});

/* Start App */
var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', manRouter);
app.use('/man', manRouter);
app.use('/api', apiRouter);
app.use('/repos', reposRouter);

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
  res.render('error');
});

module.exports = app;
