const status = document.querySelector('#status');
const loginForm = document.querySelector('#login-form');
const loginMessage = document.querySelector('#login-message');
const loginSection = document.querySelector('#login-section');
const logoutButton = document.querySelector('#logout-button');

async function checkAuthState() {
    try {
        const response = await fetch('/api/whoami');
        const data = await response.json();

        if (data.loggedIn) {
            status.innerHTML =
                '<h1>Welcome back!</h1>';
            loginSection.hidden = true;
            logoutButton.hidden = false;
        } else {
            status.innerHTML = '<h1>Welcome!</h1>';

            loginSection.hidden = false;
            logoutButton.hidden = true;
        }
    } catch (error) {
        console.error('Auth check failed:', error);

        status.innerHTML = '<h1>Welcome!</h1>';
        loginSection.hidden = false;
        logoutButton.hidden = true;
    }
}

loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const password = document.querySelector('#password').value;
    const rememberMe = event.target.rememberMe.checked;

    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                password,
                rememberMe
            })
        });

        const data = await response.json().catch(() => ({
            success: false
        }));

        if (data.success) {
            loginMessage.textContent = 'Login successful!';
            loginForm.reset();

            await checkAuthState();

            window.location.href = data.redirect || '/';
        } else {
            loginMessage.textContent =
                data.error || 'Login failed. Please check your password.';
        }
    } catch (error) {
        console.error('Login error:', error);

        loginMessage.textContent =
            'Something went wrong while logging in.';
    }
});

checkAuthState();