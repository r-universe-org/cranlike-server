/* Express template stuff */
import createError from 'http-errors';
import logger from 'morgan';
import express from 'express';
import cors from 'cors';

/* Import database */
import {get_latest} from './src/db.js';

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
const production = process.env.NODE_ENV == 'production';
const app = express();

/* Prettify all JSON responses */
app.set('json spaces', 2)

// view engine setup
app.set('views', 'views');
app.set('view engine', 'pug');

// adapted from front-end stack
// we can remove some stuff when we port :pkg apis to frontend
app.use('/:user/:package', function(req, res, next){
  const universe = req.params.user;
  const pkg = req.params.package;
  const reserved = ["packages", "src", "bin", "api", "stats", "badges", "docs", "citation",
    "manual", "readme", "articles", "feed.xml", "sitemap.xml", "sitemap_index.xml"];
  const metapage = reserved.includes(pkg);
  if(universe == ':any' || universe == 'shared' || universe == 'cdn') {
    var query = {};
    var cdn_cache = 3600;
  } else if (metapage){
    var query = {_universes: universe};
    var cdn_cache = 60;
  } else {
    var query = {_user: universe, Package: pkg};
    var cdn_cache = 30;
  }
  return get_latest(query).then(function(doc){
    //same as front-end, see comment there
    res.set('Cache-Control', `public, max-age=60, stale-while-revalidate=${cdn_cache}`);

    //Using 'CDN-Cache-Control' would make nginx also do this and we'd need to refresh twice?
    //res.set('Cloudflare-CDN-Cache-Control', `public, max-age=60, stale-while-revalidate=${cdn_cache}`);

    if(doc){
      const etag = `W/"${doc._id}"`;
      const date = doc._published.toUTCString();
      res.set('ETag', etag);
      res.set('Last-Modified', date);
      //clients may cache front-end pages for 60s before revalidating.
      //revalidation can either be done by comparing Etag or Last-Modified.
      //do not set 'must-revalidate' as this will disallow using stale cache when server is offline.
      if(etag === req.header('If-None-Match') || date === req.header('If-Modified-Since')){
        //todo: also invalidate for updates in frontend itself?
        res.status(304).send();
      } else {
        next(); //proceed to routing
      }
    } else if(metapage) {
      //throw createError(404, `Universe not found: ${universe}`);
      next();
    } else {
      // Try to find case insensitive or in other universe
      var altquery = {_type: 'src', _nocasepkg: pkg.toLowerCase(), _universes: universe, _registered: true};
      return get_latest(altquery).then(function(alt){
        if(!alt)
          throw createError(404, `Package ${pkg} not found in ${universe}`);
        res.redirect(`https://${alt._user}.r-universe.dev/${alt.Package}${req.path.replace(/\/$/, '')}`);
      });
    };
  });
});

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
  next(createError(404, `Page not found: ${req.path}`));
});

// global error handler
app.use(function(err, req, res, next) {
  res.locals.error = err;
  res.locals.mode = req.app.get('env')

  // render the error page
  res.status(err.status || 400);
  res.render('error');
});

export default app;
