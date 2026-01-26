const { App } = require('@slack/bolt');
const fs = require('fs');
const path = require('path');
const https = require('https');
const pdf = require('pdf-parse');

// Configuration
const config = {
    // Your Slack user ID (the manager who receives timesheets)
    managerUserId: process.env.MANAGER_USER_ID,
    // HR person's Slack user ID (Erickia Elbert)
    hrUserId: process.env.HR_USER_ID,
    // Employee name (for the message)
    employeeName: process.env.EMPLOYEE_NAME || 'Roxie',
};

// Initialize the Slack app
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
});

/**
 * Download a file from Slack
 */
async function downloadFile(url, token) {
    return new Promise((resolve, reject) => {
          const options = {
                  headers: {
                            'Authorization': `Bearer ${token}`,
                  },
          };

                           https.get(url, options, (response) => {
                                   const chunks = [];
                                   response.on('data', (chunk) => chunks.push(chunk));
                                   response.on('end', () => resolve(Buffer.concat(chunks)));
                                   response.on('error', reject);
                           }).on('error', reject);
    });
}

/**
 * Parse Toggl PDF and extract total hours
 */
async function parseTogglPdf(pdfBuffer) {
    const data = await pdf(pdfBuffer);
    const text = data.text;

  // Look for "TOTAL HOURS: HH:MM:SS" pattern
  const totalHoursMatch = text.match(/TOTAL HOURS:\s*(\d{1,3}):(\d{2}):(\d{2})/i);

  if (!totalHoursMatch) {
        throw new Error('Could not find TOTAL HOURS in the PDF');
  }

  const hours = parseInt(totalHoursMatch[1], 10);
    const minutes = parseInt(totalHoursMatch[2], 10);
    const seconds = parseInt(totalHoursMatch[3], 10);

  // Look for date range
  const dateRangeMatch = text.match(/(\d{2}\/\d{2}\/\d{4})\s*[-]\s*(\d{2}\/\d{2}\/\d{4})/);
    const dateRange = dateRangeMatch
      ? `${dateRangeMatch[1]} - ${dateRangeMatch[2]}`
          : 'this week';

  return { hours, minutes, seconds, dateRange };
}

/**
 * Round time to nearest minute
 */
function roundToNearestMinute(hours, minutes, seconds) {
    let totalMinutes = hours * 60 + minutes;

  // Round based on seconds
  if (seconds >= 30) {
        totalMinutes += 1;
  }

  const roundedHours = Math.floor(totalMinutes / 60);
    const roundedMinutes = totalMinutes % 60;

  return { hours: roundedHours, minutes: roundedMinutes };
}

/**
 * Format time for the HR message
 */
function formatTimeMessage(employeeName, roundedTime, dateRange) {
    const { hours, minutes } = roundedTime;

  let timeStr = '';
    if (hours > 0) {
          timeStr += `${hours} hour${hours !== 1 ? 's' : ''}`;
    }
    if (minutes > 0) {
          if (timeStr) timeStr += ' ';
          timeStr += `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    }
    if (!timeStr) {
          timeStr = '0 minutes';
    }

  return `${employeeName}'s time for week of ${dateRange}: *${timeStr}*`;
}

/**
 * Listen for file uploads in DMs to the manager
 */
app.event('message', async ({ event, client }) => {
    try {
          // Only process messages with files
      if (!event.files || event.files.length === 0) {
              return;
      }

      // Only process DMs (im = instant message/DM)
      if (event.channel_type !== 'im') {
              return;
      }

      // Check if this is a PDF file
      const pdfFile = event.files.find(file =>
              file.mimetype === 'application/pdf' ||
              file.name.toLowerCase().endsWith('.pdf')
                                           );

      if (!pdfFile) {
              return;
      }

      // Check if filename looks like a Toggl export
      const isTogglExport = pdfFile.name.toLowerCase().includes('toggl') ||
                                  pdfFile.name.toLowerCase().includes('track') ||
                                  pdfFile.name.toLowerCase().includes('summary');

      if (!isTogglExport) {
              console.log(`Ignoring non-Toggl PDF: ${pdfFile.name}`);
              return;
      }

      console.log(`Processing Toggl PDF: ${pdfFile.name}`);

      // Download the PDF
      const pdfBuffer = await downloadFile(pdfFile.url_private, process.env.SLACK_BOT_TOKEN);

      // Parse the PDF
      const timeData = await parseTogglPdf(pdfBuffer);
          console.log(`Extracted time: ${timeData.hours}:${timeData.minutes}:${timeData.seconds}`);

      // Round to nearest minute
      const roundedTime = roundToNearestMinute(timeData.hours, timeData.minutes, timeData.seconds);
          console.log(`Rounded time: ${roundedTime.hours}h ${roundedTime.minutes}m`);

      // Format the message
      const hrMessage = formatTimeMessage(config.employeeName, roundedTime, timeData.dateRange);

      // Send to HR
      await client.chat.postMessage({
              channel: config.hrUserId,
              text: hrMessage,
      });

      console.log(`Sent to HR: ${hrMessage}`);

      // Confirm to the manager (in the same DM)
      await client.chat.postMessage({
              channel: event.channel,
              text: `I've forwarded ${config.employeeName}'s time to Erickia:\n> ${hrMessage}`,
      });

    } catch (error) {
          console.error('Error processing timesheet:', error);

      // Notify manager of the error
      if (event.channel) {
              await client.chat.postMessage({
                        channel: event.channel,
                        text: `I had trouble processing that PDF: ${error.message}\n\nPlease check that it's a valid Toggl summary report.`,
              });
      }
    }
});

// Start the app
(async () => {
    await app.start();
    console.log('Timesheet bot is running!');
    console.log(`Listening for Toggl PDFs sent to manager (${config.managerUserId})`);
    console.log(`Will forward rounded times to HR (${config.hrUserId})`);
})();
