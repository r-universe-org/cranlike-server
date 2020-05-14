# CRANLIKE

High-performance R package server

## Description

**cranlike** is a package server providing a simple API for storing
R packages and hosting cran-like repositories. 

Packages are stored in the repository of a particular user or 
organization, and the server automatically generates the required 
repository index files from the database.
This allows R users to install packages from a particular author or 
organization using only the repo parameter in `install.packages()`.

The implementation is designed to be fast and extensible, with the
potential expose additional filters or services, and scale up to
large repositories.

## SYNOPSIS

The `/api` endpoint exposes a simple REST api to store R packages. Here `<type>` must be one of `src`, `win` or `mac`.

```
GET,POST,DELETE
  /api/<user>/<package>/<version>/<type>
```

The `/repos` endpoint exposes the CRAN-like directory structure and package index files for a given user. The R user can simply set the `repos` parameter in `install.packages()` or `available.packages()`:


```
GET
  /repos/<user>/src/contrib
  /repos/<user>/bin/windows/contrib
  /repos/<user>/bin/macosx/contrib/
```

For example the R user would use:

```r
available.packages("http://myserver.com/repos/jeroen")
install.packages("curl", repos = "http://myserver.com/repos/jeroen")
```

## Running the server

The easiest way to start your a server is to clone the this and run docker compose:

```
docker-compose up
```

Alternatively if you locally have `mongodb` and `nodejs` installed you can use:

```
./run-local.sh
```

## Debugging the database

All data is stored in two mongodb collections:

 - The `packages` collection in `cranlike` stores description fields for each package, including an `MD5sum` field that has a unique hash of the file.
 - The gridfs `files` collection stores the package blobs, where the primary `_id` is the md5 of the file. 

We don't store raw files on disk. To read raw data from the db in R you can use `mongolite` package:

```r
library(mongolite)
packages <- mongolite::mongo(db = 'cranlike', collection = 'packages',
  url = "mongodb://root:example@localhost")
packages$find()
```

To inspect the table with the files:

```r
bucket <- mongolite::gridfs(db = 'cranlike', prefix = 'files',
  url = "mongodb://root:example@localhost")
bucket$find()
```
