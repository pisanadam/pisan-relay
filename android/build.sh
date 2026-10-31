#!/bin/bash
# Builds PisanLig.apk without Gradle. Needs: JDK 17, Android build-tools 34 and platform 34.
#   SDK=<folder with build-tools (aapt2, d8, zipalign, apksigner)>  JAR=<android.jar>  KEYSTORE=<signing key>
set -e
cd "$(dirname "$0")"
OUT=build; rm -rf $OUT; mkdir -p $OUT/classes $OUT/res
$SDK/aapt2 compile --dir res -o $OUT/res.zip
$SDK/aapt2 link -o $OUT/base.apk -I "$JAR" --manifest AndroidManifest.xml -R $OUT/res.zip --auto-add-overlay
javac -encoding UTF-8 -source 8 -target 8 -bootclasspath "$JAR" -classpath "$JAR" -d $OUT/classes $(find src -name '*.java') 2>&1 | grep -v "^warning\|^Picked\|^Note\|^1 warning" || true
(cd $OUT/classes && jar cf ../classes.jar .)
$SDK/d8 --min-api 24 --lib "$JAR" --output $OUT $OUT/classes.jar
(cd $OUT && zip -q base.apk classes.dex)
$SDK/zipalign -f 4 $OUT/base.apk $OUT/aligned.apk
$SDK/apksigner sign --ks "$KEYSTORE" --ks-pass pass:${KSPASS:-pisanlig} --out ../PisanLig.apk $OUT/aligned.apk
$SDK/apksigner verify ../PisanLig.apk && echo "PisanLig.apk hazır"
