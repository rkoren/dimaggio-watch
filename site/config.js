// Site configuration. The data pipeline (see infra/) publishes streaks.json to
// S3 independently of site deploys; app.js polls this URL and falls back to
// the bundled ./data/streaks.json copy if it's unreachable.
window.STREAKS_DATA_URL =
  "https://dimaggio-watch-data-674325521451.s3.us-east-1.amazonaws.com/streaks.json";
