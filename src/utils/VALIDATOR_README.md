# User Update Validator

This validator ensures that only specific fields can be updated in the user model and prevents unauthorized field updates.

## Features

- **Field Restriction**: Only allows updating `name`, `photo`, and `active` fields
- **Type Validation**: Ensures proper data types for each field
- **Security**: Prevents updating sensitive fields like `email`, `password`, `role`, `otp`, etc.
- **Error Handling**: Returns standardized error messages

## Usage

The validator is already integrated into the userRouter:

```typescript
router.route('/user/:id')
    .get(factory.getOne(UserModel)) 
    .patch(validateUserUpdate, factory.updateOne(UserModel))
    .delete(factory.deleteOne(UserModel));
```

## Allowed Fields

- **name**: String (2-50 characters, trimmed)
- **photo**: String (valid URI or empty string)
- **active**: Boolean

## Validation Rules

1. **Field Whitelist**: Only the above fields are allowed
2. **Unknown Fields**: Any field not in the whitelist will trigger an error
3. **Type Checking**: Each field must match its expected data type
4. **Length Validation**: Name field must be between 2-50 characters

## Error Response

When validation fails, the middleware returns:
- **Status Code**: 400 (Bad Request)
- **Error Message**: "Invalid input"
- **Error Type**: AppError

## Examples

### ✅ Valid Request
```json
{
  "name": "John Doe",
  "photo": "https://example.com/photo.jpg",
  "active": true
}
```

### ❌ Invalid Requests

**Unknown field:**
```json
{
  "name": "John Doe",
  "email": "test@example.com"  // ❌ Not allowed
}
```

**Wrong data type:**
```json
{
  "name": 123,  // ❌ Should be string
  "active": "yes"  // ❌ Should be boolean
}
```

**Restricted field:**
```json
{
  "name": "John Doe",
  "password": "newpassword"  // ❌ Security risk, not allowed
}
```

## Security Benefits

- Prevents privilege escalation (can't update role)
- Prevents password changes through this endpoint
- Prevents email changes without proper verification
- Prevents OTP manipulation
- Protects internal system fields

## Implementation Details

The validator uses Joi validation library with:
- `unknown(false)`: Rejects any unknown fields
- `abortEarly: false`: Shows all validation errors
- `stripUnknown: false`: Throws error instead of stripping unknown fields
