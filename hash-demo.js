const bcrypt = require('bcryptjs');

async function demo() {
    const hash1 = await bcrypt.hash('password123', 12);
    const hash2 = await bcrypt.hash('password123', 12);
    console.log('Hash 1:', hash1);
    console.log('Hash 2:', hash2);

    console.log('Right password, hash 1:', await bcrypt.compare('password123', hash1));
    console.log('Right password, hash 2:', await bcrypt.compare('password123', hash2));
    console.log('Wrong password, hash 1:', await bcrypt.compare('password124', hash1));
}

demo();