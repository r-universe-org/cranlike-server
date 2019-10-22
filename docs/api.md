
# cranlike(7) &mdash; dynamic R package server

## SYNOPSIS

`GET /`&lt;*user*>`/src/contrib`  
`GET /`&lt;*user*>`/bin/windows/contrib`  
`GET /`&lt;*user*>`/bin/macosx/el-capitan/contrib/`  

`GET /`&lt;*user*>`/old/`&lt;*date*>`/src/contrib`  
`GET /`&lt;*user*>`/old/`&lt;*date*>`/bin/windows/contrib`  
`GET /`&lt;*user*>`/old/`&lt;*date*>`/bin/macosx/el-capitan/contrib/`  

`GET,PUT,DELETE /archive/`&lt;*user*>`/`&lt;*package*>`/`&lt;*version*>  


## DESCRIPTION

**cranlike** is a package server that provides a API for publishing
and downloading R packages. Packages can be filtered by user and date.

In addition it automatically generates the required repository pages 
and `PACKAGES.gz` index files from the package database. This allows 
R users to install packages from a particular author or organization 
using only the repo parameter in `install.packages()`.

## API

* `GET /`  
  List available users / organizations.

* `GET /` &lt;*user*> `/ {src,bin} /`  
  CRAN-like repository for packages published by a given author
  or organization. Use `any` for packages from all users.

* `GET /` &lt;*user*>  `/ old /` &lt;*date*> `/ {src,bin} /`  
  CRAN-like repository for user as it was on date (in `yyyy-mm-dd`).

* `GET,PUT,DELETE / archive /` &lt;*user*> `/` &lt;*package*> `/` &lt;*version*> `/`  
  CRUD API to upload and download package files to the server.

## EXAMPLES

install.packages('curl', repos = '[https://cran.dev/jeroen](https://cran.dev/latest/jeroen)')  
install.packages('R6', repos = '[https://cran.dev/any/old/2019-01-01](https://cran.dev/2019-01-01/any)')
