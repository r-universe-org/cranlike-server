# CRANLIKE

Package server to generate CRAN-like structures. Filtered by date, user, 

## Examples

Packages published by user `ropensci` 

```
GET /ropensci/latest/src/contrib/PACKAGES
GET /ropensci/latest/bin/windows/contrib/3.6/PACKAGES
GET /ropensci/latest/bin/macosx/el-capitan/contrib/3.6/PACKAGES
```

```
GET /ropensci/latest/src/contrib/pkg_1.2.tar.gz
GET /ropensci/latest/bin/windows/contrib/3.6/pkg_1.2.zip
GET /ropensci/latest/bin/macosx/el-capitan/contrib/3.6/pkg_1.2.tgz
```
