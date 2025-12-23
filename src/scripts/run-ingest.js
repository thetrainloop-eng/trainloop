require("dotenv").config();

const folderId = process.env.DRIVE_FOLDER_ID;

if (!folderId) {
  console.error("❌ DRIVE_FOLDER_ID is not set in .env");
  process.exit(1);
}

(async () => {
  try {
    console.log("➡️ Triggering ingestion for folder:", folderId);

    const res = await fetch("http://localhost:5000/api/ingestion-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ googleDriveFolderId: folderId }),
    });

    const text = await res.text();

    console.log("⬅️ Response status:", res.status);
    console.log("⬅️ Response body:");
    console.log(text);
  } catch (err) {
    console.error("❌ Failed to trigger ingestion:", err);
    process.exit(1);
  }
})();
