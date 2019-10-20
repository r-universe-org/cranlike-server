
# cranlike(7) &mdash; dynamic R package archive server

## SYNOPSIS

`GET /`&lt;*user*>`/src/contrib`  
`GET /`&lt;*user*>`/bin/windows/contrib`  
`GET /`&lt;*user*>`/bin/macosx/el-capitan/contrib/`  

`GET /`&lt;*user*>`/old/`&lt;*date*>`/src/contrib`  
`GET /`&lt;*user*>`/old/`&lt;*date*>`/bin/windows/contrib`  
`GET /`&lt;*user*>`/old/`&lt;*date*>`/bin/macosx/el-capitan/contrib/`  

`GET,PUT,DELETE /`&lt;*user*>`/archive/`&lt;*package*>`/`&lt;*version*>  


## DESCRIPTION

**cranlike** is a package server that provides a API for submitting
and downloading R packages. It automatically generates the required
pages and `PACKAGES.gz` index files from the package database.

This allows R users to install packages from a particular author or
organization or date using the repo parameter in `install.packages()`.

## API

* `GET /`  
  List available users / organizations.

* `GET /` &lt;*user*> `/ {src,bin} /`  
  CRAN-like repository for packages published by a given author
  or organization. Use `any` for packages from all users.

* `GET /` &lt;*user*>  `/ old /` &lt;*date*> `/ {src,bin} /`  
  CRAN-like repository for user as it was on date (in `yyyy-mm-dd`).

* `GET,PUT,DELETE /` &lt;*user*> `/ archive /` &lt;*package*> `/` &lt;*version*> `/`  
  Core CRUD API to upload and download package files from / to the 
  repository of the user or organzation.

## EXAMPLES

install.packages('curl', repos = '[https://cran.dev/jeroen](https://cran.dev/latest/jeroen)')  
install.packages('R6', repos = '[https://cran.dev/any/old/2019-01-01](https://cran.dev/2019-01-01/any)')  