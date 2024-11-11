/* Express template stuff */
import createError from 'http-errors';
import logger from 'morgan';
import express from 'express';
import cors from 'cors';

/* Routers */
import cdnRouter from './routes/cdn.js';
import packagesRouter from './routes/packages.js';
import reposRouter from './routes/repos.js';
import searchRouter from './routes/search.js';
import badgesRouter from './routes/badges.js';
import feedsRouter from './routes/feeds.js';
import sharedRouter from './routes/shared.js';
import snapshotRouter from './routes/snapshot.js';
import v2Router from './routes/v2.js';
import webrRouter from './routes/webr.js';

/* Start App */
var app = express();

/* Prettify all JSON responses */
app.set('json spaces', 2)

// view engine setup
app.set('views', 'views');
app.set('view engine', 'pug');

app.use(cors())
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/assets', express.static('assets'));
app.use('/', cdnRouter);
app.use('/', packagesRouter);
app.use('/', reposRouter);
app.use('/', searchRouter);
app.use('/', badgesRouter);
app.use('/', feedsRouter);
app.use('/', sharedRouter);
app.use('/', snapshotRouter);
app.use('/', v2Router);
app.use('/', webrRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  res.locals.message = err.message;
  res.locals.error = err;

  // render the error page
  res.status(err.status || 400);
  res.render('error');
});

export default app;
