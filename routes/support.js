const express = require('express');
const router = express.Router();
const pool = require('../db');
const nodemailer = require('nodemailer');

// Configure email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SUPPORT_EMAIL || 'smartclass.za@gmail.com',
    pass: process.env.SUPPORT_EMAIL_PASSWORD
  }
});

// ====================
// SEND SUPPORT EMAIL
// ====================
router.post('/email', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { to, subject, message, from, userName } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'Subject and message are required' 
      });
    }

    // Save support ticket to database
    const ticketResult = await client.query(
      `INSERT INTO support_tickets (user_id, user_name, user_email, subject, message)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        req.body.userId || 'guest',
        userName || 'Unknown User',
        from || 'No email provided',
        subject,
        message
      ]
    );

    const ticketId = ticketResult.rows[0].id;
    console.log(`📝 Support ticket #${ticketId} created`);

    // Send email to support team
    const supportMailOptions = {
      from: process.env.SUPPORT_EMAIL || 'smartclass.za@gmail.com',
      to: to || 'smartclass.za@gmail.com',
      subject: `📚 SmartClass Support #${ticketId}: ${subject}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 20px;">
            <h2 style="color: #7E57C2; margin: 0;">SmartClass Support Request</h2>
            <p style="color: #999; margin: 5px 0;">Ticket #${ticketId}</p>
          </div>
          <div style="background: #F9F6FC; padding: 20px; border-radius: 10px; margin: 20px 0;">
            <p><strong>From:</strong> ${userName || 'Unknown User'}</p>
            <p><strong>Email:</strong> ${from || 'No email provided'}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
            <hr style="border: 1px solid #EDE0F4; margin: 15px 0;">
            <p><strong>Subject:</strong> ${subject}</p>
            <p><strong>Message:</strong></p>
            <p style="line-height: 1.6; background: #FFFFFF; padding: 15px; border-radius: 8px;">${message}</p>
          </div>
          <p style="color: #999; font-size: 12px; text-align: center;">
            Sent from SmartClass app support form
          </p>
        </div>
      `
    };

    await transporter.sendMail(supportMailOptions);
    console.log(`✅ Support email sent to smartclass.za@gmail.com (Ticket #${ticketId})`);

    // Send auto-reply to user if email provided
    if (from && from !== 'anonymous@smartclass.app' && from.includes('@')) {
      try {
        const autoReplyOptions = {
          from: process.env.SUPPORT_EMAIL || 'smartclass.za@gmail.com',
          to: from,
          subject: `✅ We received your message - SmartClass Support #${ticketId}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="color: #7E57C2; margin: 0;">We received your message!</h2>
              </div>
              <p>Hi ${userName || 'there'},</p>
              <p>Thank you for contacting SmartClass Support. We've received your message and will get back to you within 24 hours.</p>
              <div style="background: #F9F6FC; padding: 15px; border-radius: 8px; margin: 15px 0;">
                <p style="margin: 0;"><strong>Ticket #:</strong> ${ticketId}</p>
                <p style="margin: 5px 0;"><strong>Your message:</strong> "${subject}"</p>
              </div>
              <p>Best regards,<br>The SmartClass Team</p>
            </div>
          `
        };

        await transporter.sendMail(autoReplyOptions);
        console.log(`✅ Auto-reply sent to ${from}`);
      } catch (autoReplyError) {
        console.error('Auto-reply error:', autoReplyError);
      }
    }

    res.json({ 
      success: true, 
      message: 'Email sent successfully',
      ticketId: ticketId
    });

  } catch (error) {
    console.error('❌ Send email error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to send email. Please try again.' 
    });
  } finally {
    client.release();
  }
});

// ====================
// GET SUPPORT TICKETS
// ====================
router.get('/tickets', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const userId = req.query.userId;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID required' });
    }

    const result = await client.query(
      `SELECT * FROM support_tickets 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json({ success: true, tickets: result.rows });

  } catch (error) {
    console.error('❌ Get tickets error:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;