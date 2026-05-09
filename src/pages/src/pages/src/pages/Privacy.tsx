export default function Privacy() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold mb-6">Privacy & Security</h1>
      <p className="text-sm text-gray-500 mb-8">Last updated: May 8, 2026</p>
      <div className="prose prose-gray space-y-4">
        <p><strong>Owner:</strong> Ali Raddaoui (sole proprietor)</p>
        <h2>1. Data We Collect</h2>
        <ul><li>Text you submit – sent to Google Gemini, not stored.</li><li>Usage data via Vercel Analytics and Microsoft Clarity.</li><li>Local storage for daily limit.</li><li>No personal accounts.</li></ul>
        <h2>2. How We Use Your Data</h2>
        <p>To provide the service, enforce limits, and improve the App.</p>
        <h2>3. Data Sharing and Third Parties</h2>
        <p>We use Google Gemini API, Vercel, and Microsoft Clarity. We do not sell your data.</p>
        <h2>4. Data Retention</h2>
        <p>Text is not retained. Logs follow third‑party policies.</p>
        <h2>5. Security</h2>
        <p>HTTPS encryption is used, but no transmission is 100% secure.</p>
        <h2>6. Children's Privacy</h2>
        <p>Not intended for children under 13.</p>
        <h2>7. Your Choices</h2>
        <p>Clear browser local storage to reset limit; use private mode to block analytics.</p>
        <h2>8. Changes to This Policy</h2>
        <p>Updates will be posted here.</p>
        <h2>9. Governing Law and Dispute Resolution</h2>
        <p>Same as Terms of Service.</p>
        <h2>10. Contact</h2>
        <p><a href="mailto:contact@nativewrite.ai">contact@nativewrite.ai</a></p>
      </div>
    </div>
  );
}