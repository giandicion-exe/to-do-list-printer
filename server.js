require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(express.static(path.join(__dirname, 'assets')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET || 'gcr-classroom-secret',
    resave: true,
    saveUninitialized: false,
    cookie: { 
        maxAge: 24 * 60 * 60 * 1000,
        secure: process.env.NODE_ENV === 'production'
    }
}));

const getRedirectUri = (req) => {
    if (process.env.GOOGLE_REDIRECT_URI) {
        return process.env.GOOGLE_REDIRECT_URI;
    }
    const host = req.headers['host'] || '';
    if (host.includes('onrender.com')) {
        return `https://${host}/auth/google/callback`;
    }
    return `https://to-do-list-printer.onrender.com/auth/google/callback`;
};

const SCOPES = [
    'https://www.googleapis.com/auth/classroom.courses.readonly',
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly',
    'https://www.googleapis.com/auth/classroom.rosters'
];

async function fetchCourseData(classroom, courseId) {
    try {
        const courseworkRes = await classroom.courses.courseWork.list({ courseId });
        const tasks = courseworkRes.data.courseWork || [];

        return await Promise.all(tasks.map(async (item) => {
            let status = 'TURNED_IN';
            try {
                const subRes = await classroom.courses.courseWork.studentSubmissions.list({
                    courseId,
                    courseWorkId: item.id
                });
                if (subRes.data.studentSubmissions && subRes.data.studentSubmissions.length > 0) {
                    status = subRes.data.studentSubmissions[0].state || 'NEW';
                }
            } catch (e) {
                status = 'NEW';
            }

            let due = 'NO DUE DATE';
            let rawDueDate = null;
            if (item.dueDate) {
                const m = String(item.dueDate.month).padStart(2, '0');
                const d = String(item.dueDate.day).padStart(2, '0');
                due = `${item.dueDate.year}-${m}-${d}`;
                rawDueDate = new Date(item.dueDate.year, item.dueDate.month - 1, item.dueDate.day).getTime();
            }

            return {
                id: item.id,
                title: item.title,
                dueDate: due,
                rawDueDate: rawDueDate || 9999999999999,
                points: item.maxPoints ? item.maxPoints : 0,
                pointsText: item.maxPoints ? `${item.maxPoints} PTS` : 'UNGRADED',
                link: item.alternateLink || 'https://classroom.google.com',
                status: status === 'TURNED_IN' || status === 'RETURNED' ? 'COMPLETED' : 'PENDING'
            };
        }));
    } catch (err) {
        return [];
    }
}

app.get('/', (req, res) => {
    if (req.session.tokens) return res.redirect('/dashboard');
    res.redirect('/login');
});

app.get('/login', (req, res) => {
    if (req.session.tokens) return res.redirect('/dashboard');
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { studentId, fullName, email, gmail } = req.body;
    req.session.student = {
        studentId: studentId ? studentId.trim() : '01-2526-000000',
        fullName: fullName ? fullName.trim() : 'Gian Louie Dicion',
        email: (email || gmail) ? (email || gmail).trim() : 'student@phinmaed.com'
    };
    res.redirect('/auth/google');
});

app.get('/register', (req, res) => {
    if (req.session.tokens) return res.redirect('/dashboard');
    res.render('register', { error: null });
});

app.post('/register', (req, res) => {
    const { studentId, fullName, email, gmail } = req.body;
    req.session.student = {
        studentId: studentId ? studentId.trim() : '01-2526-000000',
        fullName: fullName ? fullName.trim() : 'Gian Louie Dicion',
        email: (email || gmail) ? (email || gmail).trim() : 'student@phinmaed.com'
    };
    res.redirect('/auth/google');
});

app.get('/auth/google', (req, res) => {
    const dynamicRedirectUri = getRedirectUri(req);
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        dynamicRedirectUri
    );

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent'
    });
    res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    const dynamicRedirectUri = getRedirectUri(req);
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        dynamicRedirectUri
    );

    try {
        const { tokens } = await oauth2Client.getToken(code);
        req.session.tokens = tokens;
        oauth2Client.setCredentials(tokens);
        const classroom = google.classroom({ version: 'v1', auth: oauth2Client });

        const coursesRes = await classroom.courses.list({
            studentId: 'me',
            courseStates: ['ACTIVE']
        });
        const enrolledCourses = coursesRes.data.courses || [];

        req.session.classes = await Promise.all(
            enrolledCourses.map(async (course) => {
                const assignments = await fetchCourseData(classroom, course.id);
                return {
                    id: course.id,
                    name: course.name,
                    section: course.section || 'BSIT',
                    assignments
                };
            })
        );

        req.session.save(() => res.redirect('/dashboard'));
    } catch (error) {
        console.error('OAuth Callback Error:', error);
        res.render('login', { error: 'Google Authentication Failed. Please try again.' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

app.post('/api/sync', async (req, res) => {
    if (!req.session.tokens) return res.status(401).json({ success: false, message: 'Unauthorized' });

    try {
        const dynamicRedirectUri = getRedirectUri(req);
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            dynamicRedirectUri
        );
        oauth2Client.setCredentials(req.session.tokens);
        const classroom = google.classroom({ version: 'v1', auth: oauth2Client });

        const coursesRes = await classroom.courses.list({
            studentId: 'me',
            courseStates: ['ACTIVE']
        });
        const enrolledCourses = coursesRes.data.courses || [];

        req.session.classes = await Promise.all(
            enrolledCourses.map(async (course) => {
                const assignments = await fetchCourseData(classroom, course.id);
                return {
                    id: course.id,
                    name: course.name,
                    section: course.section || 'BSIT',
                    assignments
                };
            })
        );

        req.session.save(() => {
            res.json({ success: true, classes: req.session.classes });
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/dashboard', async (req, res) => {
    if (!req.session.tokens) return res.redirect('/login');

    try {
        const dynamicRedirectUri = getRedirectUri(req);
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            dynamicRedirectUri
        );
        oauth2Client.setCredentials(req.session.tokens);
        const classroom = google.classroom({ version: 'v1', auth: oauth2Client });

        const coursesRes = await classroom.courses.list({
            studentId: 'me',
            courseStates: ['ACTIVE']
        });
        const enrolledCourses = coursesRes.data.courses || [];

        req.session.classes = await Promise.all(
            enrolledCourses.map(async (course) => {
                const assignments = await fetchCourseData(classroom, course.id);
                return {
                    id: course.id,
                    name: course.name,
                    section: course.section || 'BSIT',
                    assignments
                };
            })
        );
        
        await new Promise((resolve) => req.session.save(resolve));
    } catch (err) {
        console.error('Failed to fetch fresh classes on dashboard load:', err.message);
    }

    const errorMsg = req.session.error || null;
    req.session.error = null;

    res.render('dashboard', {
        classes: req.session.classes || [],
        error: errorMsg,
        student: req.session.student || { fullName: 'Student', studentId: '0000', email: '' }
    });
});

app.post('/dashboard/remove-class', async (req, res) => {
    if (!req.session.tokens) return res.redirect('/login');

    const { classId } = req.body;

    if (classId) {
        try {
            const dynamicRedirectUri = getRedirectUri(req);
            const oauth2Client = new google.auth.OAuth2(
                process.env.GOOGLE_CLIENT_ID,
                process.env.GOOGLE_CLIENT_SECRET,
                dynamicRedirectUri
            );
            oauth2Client.setCredentials(req.session.tokens);
            const classroom = google.classroom({ version: 'v1', auth: oauth2Client });

            await classroom.courses.students.delete({
                courseId: classId,
                userId: 'me'
            });
        } catch (apiErr) {
            console.error('Failed to unenroll via GCR API:', apiErr.message);
        }

        if (req.session.classes) {
            req.session.classes = req.session.classes.filter(c => String(c.id) !== String(classId));
        }
    }

    req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect('/dashboard');
    });
});

app.listen(port, () => {
    console.log(`To Do Monitor Running on http://localhost:${port}`);
});
