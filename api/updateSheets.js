import { google } from 'googleapis';

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const { type, data } = req.body;

    // We will extract these from the server environment securely
    const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    const sheetId = process.env.GOOGLE_SHEET_ID;

    if (!clientEmail || !privateKey || !sheetId) {
      console.warn("⚠️ Google Sheets credentials missing in environment. Skipping sheet update.");
      return res.status(200).json({ status: 'mock_success', message: 'Credentials missing, but avoiding error on frontend' });
    }

    // Authenticate with Google
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: clientEmail,
        private_key: privateKey,
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    // Fetch spreadsheet metadata to check if the tabs exist
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
    });
    const sheetTitles = spreadsheet.data.sheets.map(s => s.properties.title);

    let targetTab = '';
    let headers = [];
    let range = '';
    let values = [];

    if (type === 'appointment') {
      targetTab = 'Appointments';
      headers = ['Timestamp', 'Patient Name', 'Patient Phone', 'Appointment Date', 'Time Slot', 'Status'];
      range = `${targetTab}!A:F`;
      values = [[timestamp, data.patient_name, data.patient_phone, data.appointment_date, data.time_slot, 'Booked']];
    } else if (type === 'cancel_appointment') {
      // Find the matching row and mark it CANCELLED
      targetTab = 'Appointments';
      const readRes = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${targetTab}!A:F`,
      });
      const rows = readRes.data.values || [];
      // Find row index matching phone + date + slot (columns C, D, E = index 2, 3, 4)
      let matchRowIndex = -1;
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (
          row[2] === data.patient_phone &&
          row[3] === data.appointment_date &&
          row[4] === data.time_slot &&
          row[5] !== 'CANCELLED'
        ) {
          matchRowIndex = i + 1; // Sheets is 1-indexed
          break;
        }
      }
      if (matchRowIndex === -1) {
        // Row not found — not a hard error, just log and return ok
        return res.status(200).json({ status: 'not_found', message: 'Row not found in sheet, already removed or never logged.' });
      }
      // Update the Status column (F) for that row
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${targetTab}!F${matchRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['CANCELLED']] },
      });
      return res.status(200).json({ status: 'success', message: `Row ${matchRowIndex} marked CANCELLED.` });
    } else if (type === 'b2b_query') {
      targetTab = 'B2B_Queries';
      headers = ['Timestamp', 'Contact Name', 'Company Name', 'Email', 'Phone', 'Estimated Quantity', 'Requirements'];
      range = `${targetTab}!A:G`;
      values = [[timestamp, data.name, data.companyName, data.email, data.phone, data.quantity, data.requirements]];
    } else {
      return res.status(400).json({ message: 'Invalid payload type' });
    }

    // If tab doesn't exist, create it and write headers first
    if (!sheetTitles.includes(targetTab)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: targetTab,
                },
              },
            },
          ],
        },
      });

      // Write headers to the new tab
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: `${targetTab}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [headers],
        },
      });
    }

    // Append data to sheet
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: range,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: values,
      },
    });

    return res.status(200).json({ status: 'success', data: response.data });
  } catch (error) {
    console.error('❌ Error updating Google Sheets:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
}
